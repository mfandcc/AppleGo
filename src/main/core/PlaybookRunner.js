'use strict'
/**
 * PlaybookRunner —— 按剧本在每个实例上跑一串步骤。
 *
 * 和主从同步的分工:
 *   同步引擎 = 人在主机上操作,从机跟着做(探索、登录、处理意外情况)
 *   剧本     = 完全确定的那几步(选颜色/容量/不要 AppleCare/加入购物袋)不需要人,直接跑
 * 抢购的典型用法是两者叠加:提前用剧本把所有实例推到"只差最后一下"的状态,
 * 到点由定时器统一开火,或者人在主机上点一下、其余跟上。
 *
 * 每个实例各跑各的(并发),一个实例卡住不拖累别人。
 * 点击一律走"DOM 定位 + 真实输入注入",不用 element.click()(那个 isTrusted 是 false)。
 */

const InputCodec = require('./InputCodec.js')

const DEFAULT_STEP_TIMEOUT = 15000

class PlaybookRunner {
  /**
   * @param {object} deps { rpc, logger, clock }
   */
  constructor(deps) {
    this.rpc = deps.rpc
    this.logger = deps.logger || { info() {}, warn() {}, error() {} }
    this.clock = deps.clock || null
    this.running = new Map()      // instanceId -> {abort:boolean}
  }

  /**
   * @param {object} playbook { name, steps: [] }
   * @param {Array} instances 实例数组(要有 webContents / zoomFactor / id / navigate)
   * @param {object} [opts] { vars: {instanceId: {k:v}} }
   */
  async run(playbook, instances, opts = {}) {
    const t0 = Date.now()
    this.logger.info('开始执行剧本', { name: playbook.name, steps: playbook.steps.length, instances: instances.length })

    const results = await Promise.all(instances.map(inst => this._runOne(playbook, inst, opts)))

    const ok = results.filter(r => r.ok).length
    this.logger.info('剧本执行完毕', {
      name: playbook.name, ok, total: results.length, elapsedMs: Date.now() - t0,
      失败: results.filter(r => !r.ok).map(r => `#${r.instanceId}@${r.failedAt}:${r.reason}`),
    })
    return { name: playbook.name, ok, total: results.length, elapsedMs: Date.now() - t0, results }
  }

  abort(instanceId) {
    const s = this.running.get(instanceId)
    if (s) s.abort = true
  }

  abortAll() { for (const s of this.running.values()) s.abort = true }

  async _runOne(playbook, inst, opts) {
    const token = { abort: false }
    this.running.set(inst.id, token)
    const vars = (opts.vars && opts.vars[inst.id]) || {}
    const trace = []

    try {
      for (let i = 0; i < playbook.steps.length; i++) {
        if (token.abort) return { instanceId: inst.id, ok: false, reason: 'aborted', failedAt: i, trace }
        const step = playbook.steps[i]
        const t0 = Date.now()
        const res = await this._step(step, inst, vars)
        trace.push({ i, op: step.op, label: step.label || null, ok: res.ok, reason: res.reason, ms: Date.now() - t0 })
        if (!res.ok && step.optional !== true) {
          return { instanceId: inst.id, ok: false, reason: res.reason, failedAt: i, step: step.op, trace }
        }
      }
      return { instanceId: inst.id, ok: true, trace }
    } finally {
      this.running.delete(inst.id)
    }
  }

  async _step(step, inst, vars) {
    const wc = inst.webContents
    if (!wc || wc.isDestroyed()) return { ok: false, reason: 'destroyed' }

    switch (step.op) {
      case 'navigate': {
        const url = interpolate(step.url, vars)
        inst.navigate(url)
        // 等到 DOM 可用为止,而不是死等固定时间
        return this._waitForLoad(wc, step.timeoutMs || DEFAULT_STEP_TIMEOUT)
      }

      case 'waitFor':
        return this.rpc.call(wc, 'waitFor', {
          selector: step.selector, timeoutMs: step.timeoutMs || DEFAULT_STEP_TIMEOUT, visible: step.visible !== false,
        }, { timeoutMs: (step.timeoutMs || DEFAULT_STEP_TIMEOUT) + 1500 })

      case 'click':
        return this._click(inst, step)

      case 'fill': {
        const value = step.value != null ? interpolate(step.value, vars) : vars[step.var]
        if (value == null) return { ok: false, reason: 'no-value:' + (step.var || '') }
        return this.rpc.call(wc, 'fill', { selector: step.selector, value, clear: step.clear !== false })
      }

      case 'scrollTo':
        return this.rpc.call(wc, 'scrollTo', { x: step.x || 0, y: step.y || 0 })

      case 'sleep':
        await sleep(step.ms || 200)
        return { ok: true }

      case 'script': {
        // 明确的逃生舱:剧本表达不了的站点特例交给它。只在用户自己写的剧本里出现。
        try { const v = await wc.executeJavaScript(step.code, true); return { ok: true, value: v } }
        catch (err) { return { ok: false, reason: 'script-threw', error: String(err && err.message || err) } }
      }

      case 'reload':
        wc.reload()
        return this._waitForLoad(wc, step.timeoutMs || DEFAULT_STEP_TIMEOUT)

      case 'prime':
        return this.rpc.call(wc, 'prime', { key: step.key, descriptor: descriptorFor(step.selector) })

      default:
        return { ok: false, reason: 'unknown-op:' + step.op }
    }
  }

  /**
   * 定位 + 真实输入注入。这是剧本里唯一会产生"点击"的地方。
   *
   * 点完可以带一次断言重试:实站上单选框偶尔会漏选(页面正在重渲染、事件被吃掉),
   * 只发不看的话剧本会带着一个错误的配置继续往下跑,最后加进购物袋的是别的型号。
   */
  async _click(inst, step) {
    const wc = inst.webContents
    const descriptor = step.descriptor || descriptorFor(step.selector)
    const attempts = Math.max(1, step.retries == null ? (step.expectChecked ? 3 : 1) : step.retries + 1)
    let last = null

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const r = await this.rpc.call(wc, 'resolve', { descriptor, autoScroll: true },
        { timeoutMs: step.timeoutMs || 4000 })
      if (!r || !r.ok) { last = { ok: false, reason: (r && r.reason) || 'resolve-failed' }; await sleep(180); continue }

      const events = InputCodec.encode(
        { kind: 'mouse', action: 'click', clickCount: step.clickCount || 1 },
        // 用页面这次回报的 innerWidth 现算缩放,和坐标同源,不存在测量滞后
        { zoomFactor: zoomOf(inst, r.vw), cssX: r.cssX, cssY: r.cssY }
      )
      try { for (const e of events) wc.sendInputEvent(e) }
      catch (err) { return { ok: false, reason: 'send-failed', error: String(err) } }

      if (step.settleMs !== 0) await sleep(step.settleMs || 140)

      if (!step.expectChecked && !step.expectGone) {
        return { ok: true, strategy: r.strategy, cssX: r.cssX, cssY: r.cssY, retargeted: r.retargetedToLabel, attempt }
      }

      const assertion = await this.rpc.call(wc, 'assert', {
        selector: step.selector,
        checked: step.expectChecked ? true : undefined,
        exists: step.expectGone ? false : undefined,
      }, { timeoutMs: 1500 })

      if (assertion && assertion.ok) {
        return { ok: true, strategy: r.strategy, cssX: r.cssX, cssY: r.cssY, retargeted: r.retargetedToLabel, attempt }
      }
      last = { ok: false, reason: 'assert-failed:' + ((assertion && assertion.reason) || '?'), attempt }
      await sleep(260)   // 给页面一点重渲染的时间再重试
    }
    return last || { ok: false, reason: 'click-failed' }
  }

  _waitForLoad(wc, timeoutMs) {
    return new Promise(resolve => {
      let done = false
      const finish = (ok, reason) => {
        if (done) return
        done = true
        clearTimeout(timer)
        wc.off('did-finish-load', onOk)
        wc.off('did-fail-load', onFail)
        resolve({ ok, reason })
      }
      const onOk = () => finish(true)
      const onFail = (_e, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) finish(false, `${desc}(${code})`) }
      const timer = setTimeout(() => finish(false, 'load-timeout'), timeoutMs)
      wc.once('did-finish-load', onOk)
      wc.on('did-fail-load', onFail)
    })
  }
}

/** 由 CSS 选择器造一个最小 descriptor,让 Locator 的 path / testAttr / id 策略能用上 */
/** 坐标换算只许用实际生效的缩放:优先按页面回报的 innerWidth 现算 */
function zoomOf(inst, vw) {
  const w = inst.bounds ? inst.bounds.w : inst.boundsW
  if (vw > 0 && w > 0) return w / vw
  if (typeof inst.actualZoomFactor === 'function') return inst.actualZoomFactor()
  return inst.zoomFactor == null ? 1 : inst.zoomFactor
}

function descriptorFor(selector) {
  const s = String(selector || '').trim()
  const idM = /^#([\w-]+)$/.exec(s)
  const attrM = /^\[([\w-]+)="([^"]+)"\]$/.exec(s)
  return {
    tag: '*',
    id: idM ? idM[1] : null,
    testAttr: attrM ? { attr: attrM[1], value: attrM[2] } : null,
    path: s,
    offset: { x: 0.5, y: 0.5 },
    size: null,
  }
}

/** 把 {{varName}} 替换成实例变量 */
function interpolate(tpl, vars) {
  if (typeof tpl !== 'string') return tpl
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => (vars[k] != null ? String(vars[k]) : ''))
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { PlaybookRunner, descriptorFor, interpolate }
