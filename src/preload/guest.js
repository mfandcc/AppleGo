'use strict'
/**
 * guest preload —— 注入到每一个被控页面(目标网站)里。
 *
 * 两个角色,由主进程下发:
 *   master:开启捕获,把用户的真实操作归一化成 SyncEvent 上报给主进程
 *   slave :关闭捕获,只响应主进程的 RPC(解析落点、预热、填表、汇报状态)
 *
 * 【为什么必须按角色开关捕获】
 * 实测 #2:sendInputEvent 注入的事件 isTrusted === true,页面里根本分不出是真人还是注入。
 * 如果从机也在捕获,它会把收到的注入事件当成用户操作再上报一遍 → 自激循环 → 事件风暴。
 * 所以第一道闸门就在这里:**从机绝不捕获**。主进程侧还有静默窗口和来源校验两道。
 *
 * 运行在 contextIsolation 的隔离世界:有 DOM,页面的 JS 碰不到这里的变量,
 * 也就无法覆盖 Locator 或伪造上报。
 */

const { ipcRenderer, contextBridge } = require('electron')
const Locator = require('../shared/Locator.js')

const CH = {
  ready: 'applego:guest:ready',
  event: 'applego:guest:event',
  state: 'applego:guest:state',
  role: 'applego:guest:role',
  rpc: 'applego:guest:rpc',
  rpcResult: 'applego:guest:rpc-result',
  trigger: 'applego:guest:trigger',
}

let role = 'slave'
let captureOpts = { hover: true, hoverThrottleMs: 40, keys: true, wheel: true }
let instanceId = null
const primed = new Map()          // key -> {descriptor, cssX, cssY, at}
const triggers = new Map()        // key -> {obs, poll, ttl}

function disarmTrigger(key) {
  const t = triggers.get(key)
  if (!t) return
  try { t.obs.disconnect() } catch (e) { /* ignore */ }
  clearInterval(t.poll)
  clearTimeout(t.ttl)
  triggers.delete(key)
}

/* ------------------------------------------------------------------ 上报 */

function emit(ev) {
  if (role !== 'master') return   // 闸门一:从机永不上报
  ev.instanceId = instanceId
  ev.at = Date.now()
  try { ipcRenderer.send(CH.event, ev) } catch (e) { /* 窗口正在销毁 */ }
}

function describeTarget(e) {
  try {
    return Locator.describe(e.target, { clientX: e.clientX, clientY: e.clientY })
  } catch (err) { return null }
}

function baseMouse(e) {
  return {
    cssX: e.clientX, cssY: e.clientY,
    button: e.button, buttons: e.buttons, clickCount: e.detail || 1,
    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
  }
}

/* ------------------------------------------------------------------ 捕获 */

let hoverLast = 0
const handlers = {
  click(e) {
    emit({ kind: 'mouse', action: 'click', ...baseMouse(e), descriptor: describeTarget(e) })
  },
  contextmenu(e) {
    emit({ kind: 'mouse', action: 'contextmenu', ...baseMouse(e), descriptor: describeTarget(e) })
  },
  mousemove(e) {
    if (!captureOpts.hover) return
    const now = Date.now()
    if (now - hoverLast < captureOpts.hoverThrottleMs) return
    hoverLast = now
    // hover 不带 descriptor:算 descriptor 要读 DOM,每 40ms 一次太贵,而且 hover 打偏无所谓
    emit({ kind: 'mouse', action: 'move', cssX: e.clientX, cssY: e.clientY, buttons: e.buttons })
  },
  wheel(e) {
    if (!captureOpts.wheel) return
    emit({ kind: 'wheel', cssX: e.clientX, cssY: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
           shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey })
  },
  keydown(e) {
    if (!captureOpts.keys) return
    emit({ kind: 'key', action: 'down', key: e.key, code: e.code,
           shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey })
  },
  keyup(e) {
    if (!captureOpts.keys) return
    emit({ kind: 'key', action: 'up', key: e.key, code: e.code,
           shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey })
  },
}

let attached = false
function attachCapture() {
  if (attached) return
  attached = true
  for (const type of Object.keys(handlers)) {
    document.addEventListener(type, handlers[type], { capture: true, passive: true })
  }
}
function detachCapture() {
  if (!attached) return
  attached = false
  for (const type of Object.keys(handlers)) {
    document.removeEventListener(type, handlers[type], { capture: true })
  }
}

function setRole(next, opts) {
  role = next === 'master' ? 'master' : 'slave'
  if (opts) captureOpts = { ...captureOpts, ...opts }
  if (role === 'master') attachCapture(); else detachCapture()
}

/* ------------------------------------------------------------------ 点击结果观测 */

/**
 * 一个**只记录、永不上报**的点击环形缓冲。
 *
 * 为什么它不违反"从机不捕获"的闸门:闸门管的是**发出**,不是**观察**。
 * 这个监听器任何时候都不会主动 send,只有主进程用 RPC 来拉时才交出去,
 * 所以不会产生自激回声。
 *
 * 它解决的是一个很要命的问题:sendInputEvent 不抛错 ≠ 真的点中了。
 * 没有它,中控台会出现"50 个格子全绿、实际只成交 1 单"。
 */
const outcomes = []
const OUTCOME_MAX = 48

function signatureOf(el) {
  if (!el || el.nodeType !== 1) return null
  const target = Locator.liftToInteractive(el)
  const ta = (() => {
    for (const attr of Locator.TEST_ATTRS) {
      const v = target.getAttribute && target.getAttribute(attr)
      if (v) return { attr, value: v }
    }
    return null
  })()
  return {
    tag: target.tagName.toLowerCase(),
    id: target.id || null,
    testAttr: ta,
    text: Locator.normalizeText(target.innerText || target.textContent || '', 40),
  }
}

document.addEventListener('click', e => {
  try {
    outcomes.push({ ts: Date.now(), trusted: e.isTrusted, x: e.clientX, y: e.clientY, sig: signatureOf(e.target) })
    if (outcomes.length > OUTCOME_MAX) outcomes.shift()
  } catch (err) { /* 观测不能影响页面 */ }
}, { capture: true, passive: true })

/** descriptor 和实际被点到的元素签名是不是同一个东西 */
function sigMatches(d, sig) {
  if (!d || !sig) return false
  if (d.id && sig.id && d.id === sig.id) return true
  if (d.testAttr && sig.testAttr && d.testAttr.attr === sig.testAttr.attr && d.testAttr.value === sig.testAttr.value) return true
  if (d.text && sig.text && d.text === sig.text && (!d.tag || d.tag === '*' || d.tag === sig.tag)) return true
  return false
}

/* ------------------------------------------------------------------ 需要人工介入的检测 */

/**
 * 检测页面是否出现了验证码 / 风控拦截。
 * 用途是**把这个实例升为焦点交给人处理**,不是为了绕过它 —— 本项目不实现任何验证码破解。
 */
const HUMAN_NEEDED_SELECTORS = [
  'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[title*="captcha" i]',
  '.geetest_panel', '.geetest_holder', '#nc_1_wrapper', '.nc-container',
  '[class*="captcha" i]', '[id*="captcha" i]', '[class*="slider-verify" i]',
]

function detectHumanNeeded() {
  for (const sel of HUMAN_NEEDED_SELECTORS) {
    let el
    try { el = document.querySelector(sel) } catch (e) { continue }
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (r.width > 40 && r.height > 40) return { needed: true, hint: sel }
  }
  const t = (document.title || '') + ' ' + (document.body ? (document.body.innerText || '').slice(0, 300) : '')
  if (/验证|滑块|人机|安全验证|访问受限|too many requests|access denied/i.test(t)) {
    return { needed: true, hint: 'text' }
  }
  return { needed: false }
}

/* ------------------------------------------------------------------ RPC(主进程 -> 本页) */

const rpcMethods = {
  /** 解析一个 descriptor,算出该打哪个 CSS 坐标 */
  resolve({ descriptor, autoScroll }) {
    const r = Locator.resolve(descriptor, document, { autoScroll: autoScroll !== false })
    // element 是 DOM 对象,不能过 IPC,剥掉。
    // vw 一并带回:主进程用 `view 物理宽 / vw` 当场算出**此刻真实生效**的缩放,
    // 和坐标出自同一次快照,从根上消除"缩放已变但主进程还没测到"的竞态。
    return { ok: r.ok, reason: r.reason, strategy: r.strategy, confidence: r.confidence,
             candidates: r.candidates, conflicts: r.conflicts, cssX: r.cssX, cssY: r.cssY,
             actionable: r.actionable, retargetedToLabel: r.retargetedToLabel,
             vw: window.innerWidth, vh: window.innerHeight }
  },

  /**
   * 预热:抢购前把目标元素先解析好缓存下来。
   * 到点那一刻就不用再走 DOM 查询了,关键路径只剩一次 sendInputEvent。
   */
  prime({ key, descriptor }) {
    const r = Locator.resolve(descriptor, document, { autoScroll: true })
    if (r.ok) primed.set(key, { descriptor, cssX: r.cssX, cssY: r.cssY, at: Date.now(), strategy: r.strategy })
    return { ok: r.ok, reason: r.reason, strategy: r.strategy, cssX: r.cssX, cssY: r.cssY,
             confidence: r.confidence, vw: window.innerWidth }
  },

  /** 读预热结果。stale 为 true 表示元素位置已经变了,调用方应该重新 resolve。 */
  getPrimed({ key, verify }) {
    const p = primed.get(key)
    if (!p) return { ok: false, reason: 'not-primed' }
    if (verify === false) return { ok: true, cssX: p.cssX, cssY: p.cssY, strategy: p.strategy, age: Date.now() - p.at, vw: window.innerWidth }
    const r = Locator.resolve(p.descriptor, document, { autoScroll: false })
    if (!r.ok) return { ok: false, reason: r.reason }
    const moved = Math.abs(r.cssX - p.cssX) > 2 || Math.abs(r.cssY - p.cssY) > 2
    if (moved) { p.cssX = r.cssX; p.cssY = r.cssY; p.at = Date.now() }
    return { ok: true, cssX: r.cssX, cssY: r.cssY, strategy: r.strategy, moved, age: Date.now() - p.at, vw: window.innerWidth }
  },

  clearPrimed({ key }) { if (key) primed.delete(key); else primed.clear(); return { ok: true } },

  /** 等某个选择器出现(抢购剧本里的 waitFor) */
  waitFor({ selector, timeoutMs = 8000, visible = true }) {
    return new Promise(resolve => {
      const started = Date.now()
      const hit = () => {
        let el
        try { el = document.querySelector(selector) } catch (e) { return null }
        if (!el) return null
        if (visible && !Locator.isActionable(el, window)) return null
        return el
      }
      const first = hit()
      if (first) return resolve({ ok: true, elapsed: 0 })
      const obs = new MutationObserver(() => {
        if (hit()) { obs.disconnect(); clearTimeout(timer); resolve({ ok: true, elapsed: Date.now() - started }) }
      })
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
      const timer = setTimeout(() => { obs.disconnect(); resolve({ ok: false, reason: 'timeout', elapsed: Date.now() - started }) }, timeoutMs)
    })
  },

  /**
   * 填表。用原生 setter 改 value 再派发 input/change ——
   * React/Vue 把 value 劫持成了属性访问器,直接 el.value= 会被框架的状态覆盖回去。
   */
  fill({ selector, value, clear = true }) {
    let el
    try { el = document.querySelector(selector) } catch (e) { return { ok: false, reason: 'bad-selector' } }
    if (!el) return { ok: false, reason: 'not-found' }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')
    el.focus()
    if (clear && setter && setter.set) setter.set.call(el, '')
    if (setter && setter.set) setter.set.call(el, String(value))
    else el.value = String(value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, value: el.value }
  },

  /** 页面状态快照,中控看板用 */
  state() {
    const human = detectHumanNeeded()
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollY: window.scrollY,
      viewport: [window.innerWidth, window.innerHeight],
      humanNeeded: human.needed,
      humanHint: human.hint || null,
    }
  },

  /** 滚到某处(同步滚动位置用) */
  scrollTo({ x = 0, y = 0 }) { window.scrollTo(x, y); return { ok: true, scrollY: window.scrollY } },

  /**
   * 注入之后回来问一句:刚才那一下**真的点到东西了吗?点到的是不是我想点的那个?**
   * 这是 injected -> effected 的唯一可信来源。
   */
  outcomeSince({ sinceTs, descriptor }) {
    const recent = outcomes.filter(o => o.ts >= (sinceTs || 0))
    if (!recent.length) return { ok: true, clicked: false, effected: false, reason: 'no-click' }
    const hit = descriptor ? recent.find(o => sigMatches(descriptor, o.sig)) : recent[recent.length - 1]
    return {
      ok: true,
      clicked: true,
      effected: !!hit,
      hitWhat: hit ? (hit.sig.testAttr ? hit.sig.testAttr.value : (hit.sig.id || hit.sig.text || hit.sig.tag)) : null,
      wrongTarget: !hit ? recent.map(o => o.sig && (o.sig.id || (o.sig.testAttr && o.sig.testAttr.value) || o.sig.text || o.sig.tag)).slice(0, 3) : null,
      count: recent.length,
    }
  },

  clearOutcomes() { outcomes.length = 0; return { ok: true } },

  /** 断言页面状态。剧本点完一步之后用它确认"真的选上了",而不是假设点了就生效。 */
  assert({ selector, checked, exists, visible }) {
    let el
    try { el = document.querySelector(selector) } catch (e) { return { ok: false, reason: 'bad-selector' } }
    if (exists === false) return { ok: !el, reason: el ? 'still-exists' : undefined }
    if (!el) return { ok: false, reason: 'not-found' }
    if (checked != null && !!el.checked !== !!checked) return { ok: false, reason: 'not-checked' }
    if (visible && !Locator.isActionable(el, window)) return { ok: false, reason: 'not-visible' }
    return { ok: true }
  },

  /**
   * 守株待兔:目标元素**现在还不存在**时用这个。
   *
   * 抢首发的实际情况是:开售前页面上根本没有「添加到购物袋」按钮(实测 18 Pro 配置页只有「继续」),
   * 所以"预热 + 到点开火"那套用不上 —— 没有东西可以预热。
   * 这里改成在页面里挂一个 MutationObserver,按钮一出现就**立刻主动上报**给主进程,
   * 主进程收到后当场注入。整条链路是"事件驱动"而不是轮询,延迟只有一帧 + 一次 IPC。
   *
   * 同时兜一层低频轮询:有些改动不经过 DOM 变更(比如按钮一直在、只是从 disabled 变可用)。
   */
  armTrigger({ key, descriptor, ttlMs = 15 * 60 * 1000 }) {
    disarmTrigger(key)
    const started = Date.now()
    let fired = false

    const attempt = () => {
      if (fired) return false
      const r = Locator.resolve(descriptor, document, { autoScroll: true })
      if (!r.ok || !r.actionable) return false
      fired = true
      disarmTrigger(key)
      try {
        ipcRenderer.send(CH.trigger, {
          key, instanceId,
          cssX: r.cssX, cssY: r.cssY, vw: window.innerWidth,
          strategy: r.strategy, confidence: r.confidence,
          waitedMs: Date.now() - started,
        })
      } catch (e) { /* 窗口正在销毁 */ }
      return true
    }

    if (attempt()) return { ok: true, immediate: true }

    const obs = new MutationObserver(() => { attempt() })
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    // 兜底轮询:DOM 没变但元素变可用的情况观察器看不到
    const poll = setInterval(attempt, 250)
    const ttl = setTimeout(() => disarmTrigger(key), ttlMs)
    triggers.set(key, { obs, poll, ttl })
    return { ok: true, immediate: false }
  },

  disarmTrigger({ key }) { disarmTrigger(key); return { ok: true } },

  triggerStatus() { return { ok: true, armed: Array.from(triggers.keys()) } },

  ping() { return { ok: true, at: Date.now() } },
}

ipcRenderer.on(CH.rpc, async (_e, msg) => {
  const { id, method, params } = msg || {}
  let result
  try {
    const fn = rpcMethods[method]
    result = fn ? await fn(params || {}) : { ok: false, reason: 'unknown-method:' + method }
  } catch (err) {
    result = { ok: false, reason: 'threw', error: String(err && err.message || err) }
  }
  try { ipcRenderer.send(CH.rpcResult, { id, result }) } catch (e) { /* ignore */ }
})

ipcRenderer.on(CH.role, (_e, msg) => {
  instanceId = msg && msg.instanceId != null ? msg.instanceId : instanceId
  setRole(msg && msg.role, msg && msg.captureOpts)
})

/* ------------------------------------------------------------------ 生命周期 */

let lastState = ''
function reportState() {
  try {
    const s = rpcMethods.state()
    const key = s.href + '|' + s.title + '|' + s.readyState + '|' + s.humanNeeded
    if (key === lastState) return
    lastState = key
    ipcRenderer.send(CH.state, { instanceId, ...s })
  } catch (e) { /* ignore */ }
}

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send(CH.ready, { instanceId, href: location.href, title: document.title })
  reportState()
})
window.addEventListener('load', reportState)
setInterval(reportState, 1500)

// 页面跳转后角色要重新下发,这里主动要一次,避免主机换页后同步静默失效
ipcRenderer.send(CH.ready, { instanceId, href: location.href, title: document.title, phase: 'preload' })

// 只暴露只读的调试信息,不给页面任何控制能力
// ⚠️ contextBridge 只会把普通属性求值一次就冻结,getter 拿不到实时值 —— 必须暴露函数。
contextBridge.exposeInMainWorld('__appleGo', {
  getRole: () => role,
  getCaptureOpts: () => ({ ...captureOpts }),
  version: '0.1.0',
})
