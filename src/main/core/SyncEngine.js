'use strict'
/**
 * SyncEngine —— 主从同步引擎。
 *
 * 数据流:
 *   主机 preload 捕获
 *     → CH.event 上报(带 descriptor)
 *     → 【闸门】来源校验 / 静默窗口 / 节流
 *     → 按模式分发:
 *         semantic : 并发 RPC 让每个从机自己算落点(准) → InputCodec 换算 → sendInputEvent(真)
 *         coordinate: 直接抄主机的 CSS 坐标 → 换算 → 注入(快,但布局一致才对)
 *         auto     : 先语义,置信度不够或解析失败再退坐标,还失败就标记该实例待人工
 *     → 结果汇总成一条 SyncRecord,喂给中控看板
 *
 * 【断自激的三道闸门】(实测 #2:注入事件 isTrusted 为 true,页面分不出真假)
 *   ① 从机 preload 根本不挂捕获器(guest.js 里按角色开关)
 *   ② 主进程注入前给目标实例设 muteUntil,静默窗口内它的上报一律丢弃
 *   ③ 上报事件带 instanceId,不等于当前主机的一律丢弃
 * 任何一道单独都够用,三道叠在一起是为了扛住"切换主机瞬间"的竞态。
 */

const InputCodec = require('./InputCodec.js')

const MODES = ['auto', 'semantic', 'coordinate']

/** 注入后静默多久(毫秒)。只要盖住注入事件冒到 preload 的时间即可。 */
const MUTE_WINDOW_MS = 120

/** 语义解析的置信度低于此值就不敢用 */
const CONFIDENCE_FLOOR = 0.28

class SyncEngine {
  /**
   * @param {object} deps
   * @param {object} deps.rpc          GuestRpc
   * @param {object} deps.logger
   * @param {()=>Array} deps.getInstances  返回全部实例:{id, role, enabled, zoomFactor, webContents, status}
   * @param {(rec:object)=>void} [deps.onRecord] 每次分发的结果汇总(中控看板订阅)
   */
  constructor(deps) {
    this.rpc = deps.rpc
    this.logger = deps.logger || { info() {}, warn() {}, error() {}, debug() {} }
    this.getInstances = deps.getInstances
    this.onRecord = deps.onRecord || null

    this.enabled = false
    this.mode = 'auto'
    this.masterId = null
    this.allowTextKeys = false
    this.syncScroll = true

    this._mute = new Map()      // instanceId -> 静默截止时间
    this._seq = 0
    this._stats = { dispatched: 0, semantic: 0, coordinate: 0, failed: 0, effected: 0, missed: 0, lastLatencyMs: null }
    /** 注入后隔多久回头核对"到底点中没有" */
    this.verifyDelayMs = 260
    /** key -> descriptor,开火后核对结果时要用 */
    this._primedDescriptor = new Map()
    /** key -> 守株待兔的布防信息 */
    this._pounce = new Map()
  }

  /* ------------------------------------------------------------ 配置 */

  setEnabled(on) {
    this.enabled = !!on
    this.logger.info(on ? '同步已开启' : '同步已停止', { mode: this.mode, masterId: this.masterId })
    return this.enabled
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error('未知同步模式: ' + mode)
    this.mode = mode
    this.logger.info('同步模式切换', { mode })
    return this.mode
  }

  /**
   * 指定主机。切换主机时把新旧两台都短暂静默 ——
   * 否则旧主机残留在管道里的事件会被当成新主机的操作分发出去。
   */
  setMaster(instanceId) {
    const prev = this.masterId
    if (prev != null) this.mute(prev)
    this.masterId = instanceId
    if (instanceId != null) this.mute(instanceId)
    this.logger.info('主机切换', { from: prev, to: instanceId })
    return this.masterId
  }

  mute(instanceId, ms = MUTE_WINDOW_MS) {
    this._mute.set(instanceId, Date.now() + ms)
  }

  isMuted(instanceId) {
    const until = this._mute.get(instanceId)
    if (until == null) return false
    if (Date.now() > until) { this._mute.delete(instanceId); return false }
    return true
  }

  /* ------------------------------------------------------------ 入口 */

  /** 主机 preload 上报的事件从这里进来 */
  async handleMasterEvent(ev) {
    if (!this.enabled) return null
    if (!ev || ev.instanceId == null) return null

    // 闸门 ③:不是当前主机发来的,一律丢弃
    if (ev.instanceId !== this.masterId) return null
    // 闸门 ②:静默窗口内的上报是注入回声,丢弃
    if (this.isMuted(ev.instanceId)) return null

    return this.dispatch(ev)
  }

  slaves() {
    const all = this.getInstances() || []
    return all.filter(i => i.enabled !== false && i.id !== this.masterId && i.webContents && !i.webContents.isDestroyed())
  }

  /* ------------------------------------------------------------ 分发 */

  async dispatch(ev) {
    const seq = ++this._seq
    const t0 = Date.now()
    const targets = this.slaves()
    if (!targets.length) return null

    const useSemantic = ev.kind === 'mouse'
      && ev.action !== 'move'
      && !!ev.descriptor
      && (this.mode === 'semantic' || this.mode === 'auto')

    const results = useSemantic
      ? await Promise.all(targets.map(inst => this._dispatchSemantic(inst, ev)))
      : targets.map(inst => this._dispatchCoordinate(inst, ev, 'coordinate'))

    const record = {
      seq,
      at: t0,
      latencyMs: Date.now() - t0,
      kind: ev.kind,
      action: ev.action || null,
      mode: useSemantic ? this.mode : 'coordinate',
      text: ev.descriptor ? (ev.descriptor.text || ev.descriptor.tag) : null,
      total: results.length,
      ok: results.filter(r => r.ok).length,
      results,
    }

    this._stats.dispatched++
    this._stats.lastLatencyMs = record.latencyMs
    for (const r of results) {
      if (!r.ok) this._stats.failed++
      else if (r.via === 'semantic') this._stats.semantic++
      else this._stats.coordinate++
    }

    if (record.ok < record.total) {
      this.logger.warn('部分从机同步失败', {
        seq, ok: record.ok, total: record.total,
        失败: results.filter(r => !r.ok).map(r => `#${r.instanceId}:${r.reason}`),
      })
    }
    if (this.onRecord) { try { this.onRecord(record) } catch (e) { /* ignore */ } }

    // 注入成功 ≠ 点中了。异步回头核对一次,**不占关键路径**。
    if (ev.kind === 'mouse' && ev.action !== 'move') this._verifyOutcomes(record, ev, targets, t0)

    return record
  }

  /**
   * injected -> effected。
   *
   * sendInputEvent 不抛错只说明"事件发出去了",不说明页面上有东西被点到 ——
   * 弹窗盖住了、按钮 disabled、元素刚好重排走了,都会让它静默落空。
   * 不核对的话中控台会出现"全绿但一单没成"。这里延迟一拍去问每个从机:
   * 刚才那段时间里有没有一次点击落在我要的那个元素上。
   */
  _verifyOutcomes(record, ev, targets, sinceTs) {
    setTimeout(async () => {
      const injected = record.results.filter(r => r.ok)
      if (!injected.length) return
      const checks = await Promise.all(injected.map(async r => {
        const inst = targets.find(t => t.id === r.instanceId)
        if (!inst || !inst.webContents || inst.webContents.isDestroyed()) return null
        const o = await this.rpc.call(inst.webContents, 'outcomeSince',
          { sinceTs: sinceTs - 20, descriptor: ev.descriptor }, { timeoutMs: 900 })
        return { instanceId: r.instanceId, ...o }
      }))

      let effected = 0
      const misses = []
      for (const c of checks.filter(Boolean)) {
        const r = record.results.find(x => x.instanceId === c.instanceId)
        if (r) { r.effected = !!c.effected; r.hitWhat = c.hitWhat || null; r.wrongTarget = c.wrongTarget || null }
        if (c.effected) effected++
        else misses.push(`#${c.instanceId}:${c.clicked ? '点到了别的(' + (c.wrongTarget || []).join('/') + ')' : '没点到任何东西'}`)
      }
      record.effected = effected
      this._stats.effected += effected
      this._stats.missed += misses.length

      if (misses.length) {
        this.logger.warn('注入成功但没点中', { seq: record.seq, 生效: effected, 注入: injected.length, 明细: misses })
      }
      if (this.onRecord) { try { this.onRecord(record) } catch (e) { /* ignore */ } }
    }, this.verifyDelayMs)
  }

  /** 语义路径:让从机自己在 DOM 里找元素,算出落点,再注入 */
  async _dispatchSemantic(inst, ev) {
    const res = await this.rpc.call(inst.webContents, 'resolve',
      { descriptor: ev.descriptor, autoScroll: true }, { timeoutMs: 1200 })

    if (res && res.ok && (res.confidence == null || res.confidence >= CONFIDENCE_FLOOR)) {
      return this._inject(inst, ev, { cssX: res.cssX, cssY: res.cssY }, 'semantic', {
        strategy: res.strategy, confidence: res.confidence, vw: res.vw,
      })
    }

    // auto 模式下退回坐标;semantic 模式下宁可不点也不乱点
    if (this.mode === 'auto') {
      const fell = this._dispatchCoordinate(inst, ev, 'fallback-coordinate')
      fell.degraded = true
      fell.semanticReason = res && (res.reason || 'low-confidence')
      return fell
    }

    return {
      instanceId: inst.id, ok: false, via: 'semantic',
      reason: (res && res.reason) || 'low-confidence',
      confidence: res && res.confidence,
    }
  }

  /** 坐标路径:直接抄主机的页面坐标 */
  _dispatchCoordinate(inst, ev, via) {
    if (ev.kind === 'key' && !this.allowTextKeys) {
      // 文本键默认不同步,交给"变量填充"处理(各实例账号不同,照抄会串号)
    }
    return this._inject(inst, ev, null, via, {})
  }

  /**
   * 真正的注入。**全项目唯一调用 sendInputEvent 的地方** ——
   * 坐标换算(实测 #9 的 cssX × zoomFactor)只在 InputCodec 里做一次,别处不许再算。
   */
  _inject(inst, ev, override, via, meta) {
    const wc = inst.webContents
    if (!wc || wc.isDestroyed()) return { instanceId: inst.id, ok: false, via, reason: 'destroyed' }

    const events = InputCodec.encode(ev, {
      zoomFactor: zoomFor(inst, meta && meta.vw),
      cssX: override ? override.cssX : undefined,
      cssY: override ? override.cssY : undefined,
      allowTextKeys: this.allowTextKeys,
    })
    if (!events.length) return { instanceId: inst.id, ok: false, via, reason: 'nothing-to-send' }

    // 闸门 ②:注入前先静默这个实例
    this.mute(inst.id)
    try {
      for (const e of events) wc.sendInputEvent(e)
    } catch (err) {
      return { instanceId: inst.id, ok: false, via, reason: 'send-failed', error: String(err) }
    }
    return {
      instanceId: inst.id, ok: true, via, count: events.length,
      cssX: override ? override.cssX : ev.cssX,
      cssY: override ? override.cssY : ev.cssY,
      ...meta,
    }
  }

  /* ------------------------------------------------------------ 守株待兔 */

  /**
   * 目标元素**还不存在**时的打法。
   *
   * 首发抢购的真实情况:开售前页面上压根没有「添加到购物袋」按钮(实测 apple.com.cn 的 18 Pro 配置页
   * 开售前只有「继续」)。所以"预热落点 + 到点开火"那套用不上 —— 没有落点可以预热。
   * 这里让每个实例在自己页面里挂一个观察器,按钮一出现就主动上报,主进程收到后当场注入。
   * 不轮询、不空转,延迟 = 一帧 + 一次 IPC。
   *
   * @param {string} key
   * @param {object} descriptor 目标元素画像(比如 add-to-cart)
   * @param {Array} [instances]
   * @param {object} [opts] { autoFire=true, ttlMs }
   */
  async armPounce(key, descriptor, instances, opts = {}) {
    const targets = instances || this.slaves()
    this._pounce.set(key, {
      descriptor,
      autoFire: opts.autoFire !== false,
      clickCount: opts.clickCount || 1,
      armedAt: Date.now(),
      hits: [],
    })
    const res = await Promise.all(targets.map(async inst => {
      const r = await this.rpc.call(inst.webContents, 'armTrigger',
        { key, descriptor, ttlMs: opts.ttlMs || 15 * 60 * 1000 }, { timeoutMs: 4000 })
      return { instanceId: inst.id, ...r }
    }))
    const ok = res.filter(r => r.ok).length
    this.logger.info('已布下守株待兔', {
      key, ok, total: res.length,
      已命中: res.filter(r => r.immediate).map(r => r.instanceId),
    })
    return res
  }

  async disarmPounce(key, instances) {
    const targets = instances || this.slaves()
    this._pounce.delete(key)
    await Promise.all(targets.map(inst => this.rpc.call(inst.webContents, 'disarmTrigger', { key }, { timeoutMs: 2000 })))
    return { ok: true }
  }

  /** 某个实例的观察器命中了目标 —— 立刻注入 */
  handleTrigger(inst, payload) {
    const armed = this._pounce.get(payload.key)
    if (!armed) return null
    if (!armed.autoFire) { armed.hits.push({ instanceId: inst.id, at: Date.now() }); return null }

    const r = this._inject(
      inst,
      { kind: 'mouse', action: 'click', clickCount: armed.clickCount, cssX: payload.cssX, cssY: payload.cssY, descriptor: armed.descriptor },
      { cssX: payload.cssX, cssY: payload.cssY },
      'pounce',
      { strategy: payload.strategy, confidence: payload.confidence, vw: payload.vw }
    )
    armed.hits.push({ instanceId: inst.id, at: Date.now(), ok: r.ok, waitedMs: payload.waitedMs })

    const record = {
      seq: ++this._seq, at: Date.now(), latencyMs: 0, kind: 'pounce', mode: 'pounce',
      text: payload.key, total: 1, ok: r.ok ? 1 : 0, results: [r],
    }
    this.logger.info('守株命中,已扑', {
      key: payload.key, instanceId: inst.id, ok: r.ok,
      等了: payload.waitedMs + 'ms', 策略: payload.strategy,
    })
    if (this.onRecord) { try { this.onRecord(record) } catch (e) { /* ignore */ } }
    this._verifyOutcomes(record, { kind: 'mouse', action: 'click', descriptor: armed.descriptor }, [inst], record.at)
    return record
  }

  pounceStatus(key) {
    const a = this._pounce.get(key)
    return a ? { key, armedAt: a.armedAt, hits: a.hits } : null
  }

  /* ------------------------------------------------------------ 预热 */

  /**
   * 抢购预热:开抢前把目标元素在每个从机上先解析好缓存起来。
   * 到点那一刻不用再查 DOM,关键路径只剩一次 sendInputEvent(实测约 9μs)。
   */
  async prime(key, descriptor, instances) {
    const targets = instances || this.slaves()
    this._primedDescriptor.set(key, descriptor)
    const res = await Promise.all(targets.map(async inst => {
      const r = await this.rpc.call(inst.webContents, 'prime', { key, descriptor }, { timeoutMs: 3000 })
      return { instanceId: inst.id, ...r }
    }))
    const ok = res.filter(r => r.ok).length
    this.logger.info('预热完成', { key, ok, total: res.length, 失败: res.filter(r => !r.ok).map(r => `#${r.instanceId}:${r.reason}`) })
    return res
  }

  /**
   * 用预热结果开火。verify=false 时完全不回 DOM,延迟最低但可能打在旧位置。
   * 默认 verify=true:回一次 DOM 确认位置没变(约 0.1~0.3ms),值这个钱。
   */
  async fire(key, instances, { verify = true, clickCount = 1 } = {}) {
    const targets = instances || this.slaves()
    const t0 = Date.now()
    const res = await Promise.all(targets.map(async inst => {
      const p = await this.rpc.call(inst.webContents, 'getPrimed', { key, verify }, { timeoutMs: 800 })
      if (!p || !p.ok) return { instanceId: inst.id, ok: false, reason: (p && p.reason) || 'not-primed' }
      return this._inject(
        inst,
        { kind: 'mouse', action: 'click', clickCount, cssX: p.cssX, cssY: p.cssY },
        { cssX: p.cssX, cssY: p.cssY },
        'primed',
        { strategy: p.strategy, moved: p.moved, vw: p.vw }
      )
    }))
    const record = {
      seq: ++this._seq, at: t0, latencyMs: Date.now() - t0, kind: 'fire', mode: 'primed',
      text: key, total: res.length, ok: res.filter(r => r.ok).length, results: res,
    }
    this.logger.info('开火', { key, ok: record.ok, total: record.total, latencyMs: record.latencyMs })
    if (this.onRecord) { try { this.onRecord(record) } catch (e) { /* ignore */ } }
    // 抢购最需要知道的就是"到底点中了几个",所以开火路径也必须核对
    this._verifyOutcomes(record, { kind: 'mouse', action: 'click', descriptor: this._primedDescriptor.get(key) }, targets, t0)
    return record
  }

  stats() {
    return { ...this._stats, enabled: this.enabled, mode: this.mode, masterId: this.masterId, slaveCount: this.slaves().length }
  }
}

/**
 * 该用哪个缩放去换算坐标。
 *
 * 优先用页面**这一次**回报的 innerWidth 现算:`view 物理宽 / innerWidth`。
 * 它和坐标来自同一次快照,不存在"页面已经变了、主进程还没测到"的窗口。
 * 没有 vw 时(纯坐标路径)退回实例自己测到的 effectiveZoom。
 */
function zoomFor(inst, vw) {
  if (vw > 0 && inst.boundsW > 0) return inst.boundsW / vw
  if (typeof inst.actualZoomFactor === 'function') return inst.actualZoomFactor()
  return inst.zoomFactor == null ? 1 : inst.zoomFactor
}

module.exports = { SyncEngine, MODES, MUTE_WINDOW_MS, CONFIDENCE_FLOOR, zoomFor }
