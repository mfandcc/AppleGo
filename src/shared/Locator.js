'use strict'
/**
 * Locator —— 语义定位:把"主机上被点的那个元素"描述成一份可以在**别的实例**里重新找回来的画像。
 *
 * 为什么不能只同步坐标:
 *   从机和主机虽然是同一个站点,但登录态不同、A/B 分流不同、有没有弹出优惠券不同、
 *   懒加载进度不同 —— 同一个像素位置上很可能是完全不同的东西。只同步坐标就会点错。
 *
 * 为什么不能只用 element.click():
 *   那样产生的事件 isTrusted 为 false,部分站点不认。
 *
 * 所以是两段式:**用 DOM 找到元素(准),再用 sendInputEvent 打它的中心点(真)**。
 * 本文件只负责"找",坐标交给 InputCodec 换算、由主进程注入。
 *
 * 运行环境:渲染进程的 preload 隔离世界(有 document,没有 Node)。
 * 不依赖任何 Node API,因此也能被测试直接 require。
 */

/* ---------------------------------------------------------------- 稳定性判断 */

/** 一眼就能看出是框架生成的、下次刷新就会变的 id */
const UNSTABLE_ID = [
  /^[:.]/,                    // React 18 useId: ":r1:" / ":R2ab:"
  /^_+r_[0-9a-z]+_$/i,        // React 19 useId: "_r_c_" / "_r_14_" —— apple.com.cn 全站都是这个
  /^_[0-9a-z]{1,6}_$/i,       // 同类的下划线包裹短标识
  /^(ember|ext-gen|yui|aria-|radix-|headlessui-|mui-|mantine-|chakra-|downshift-)/i,
  /^[0-9a-f]{8,}$/i,          // 纯 hash
  /\d{5,}/,                   // 长数字序列,多半是时间戳或自增
  /^(react|vue|ng)-[0-9a-z]{4,}$/i,
]

const UNSTABLE_CLASS = [
  /^(css|sc|jsx|emotion|styled)[-_][0-9a-z]{4,}$/i,   // CSS-in-JS 生成类
  /^[a-z]+__[a-zA-Z0-9]{5,}$/,                        // CSS Modules 的 hash 后缀
  /^_[0-9a-z]{5,}$/i,
  /^(is|has)-/,                                        // 状态类,会随交互变化
  /(active|selected|open|hover|focus|disabled|loading|hidden)$/i,
]

/** 常见的测试属性,优先级从高到低 */
const TEST_ATTRS = [
  'data-autom',            // Apple 全站(apple.com.cn 单个配置页就有 175 个),是这个项目里最重要的一个
  'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy',
  'data-automation-id', 'data-tracking-id',
]

function isStableId(id) {
  if (typeof id !== 'string' || !id || id.length > 64) return false
  return !UNSTABLE_ID.some(re => re.test(id))
}

function isStableClass(cls) {
  if (typeof cls !== 'string' || !cls || cls.length > 48) return false
  return !UNSTABLE_CLASS.some(re => re.test(cls))
}

/** CSS 选择器转义,没有 CSS.escape 时兜底 */
function cssEscape(value) {
  const s = String(value)
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
  return s.replace(/[^\w-]/g, ch => '\\' + ch)
}

/* ---------------------------------------------------------------- 描述(主机侧) */

/**
 * 把一个元素描述成可跨实例复现的画像。
 * @param {Element} el
 * @param {object} [opts] { clientX, clientY, maxText, framePath }
 * @returns {object|null} descriptor
 */
function describe(el, opts = {}) {
  if (!el || el.nodeType !== 1) return null
  const doc = el.ownerDocument
  const win = doc.defaultView
  const maxText = opts.maxText || 64

  // 点在 <span> 上但真正的按钮是外层 <button> —— 描述"可交互的祖先"才有意义
  const target = liftToInteractive(el)

  const rect = target.getBoundingClientRect()
  const vw = (win && win.innerWidth) || 1
  const vh = (win && win.innerHeight) || 1

  const d = {
    tag: target.tagName.toLowerCase(),
    type: (target.getAttribute && target.getAttribute('type')) || null,
    id: isStableId(target.id) ? target.id : null,
    testAttr: pickTestAttr(target),
    name: (target.getAttribute && target.getAttribute('name')) || null,
    role: (target.getAttribute && target.getAttribute('role')) || implicitRole(target),
    ariaLabel: (target.getAttribute && target.getAttribute('aria-label')) || null,
    text: normalizeText(target.innerText || target.textContent || '', maxText),
    href: (target.getAttribute && target.getAttribute('href')) || null,
    classes: stableClasses(target),
    path: cssPath(target),
    // 兜底的相对位置:视口归一化坐标,所有 DOM 策略都失败时才用
    rel: { x: +((rect.left + rect.width / 2) / vw).toFixed(4), y: +((rect.top + rect.height / 2) / vh).toFixed(4) },
    // 主机上的尺寸,用来在从机侧做合理性校验(尺寸差太多多半是找错了)
    size: { w: Math.round(rect.width), h: Math.round(rect.height) },
    // 点击位置在元素内的相对偏移,复现时按从机元素的尺寸还原,而不是硬点中心
    offset: { x: 0.5, y: 0.5 },
    frame: opts.framePath || null,
  }
  if (rect.width > 0 && rect.height > 0 && opts.clientX != null && opts.clientY != null) {
    const ox = (opts.clientX - rect.left) / rect.width
    const oy = (opts.clientY - rect.top) / rect.height
    if (ox >= 0 && ox <= 1) d.offset.x = +ox.toFixed(4)
    if (oy >= 0 && oy <= 1) d.offset.y = +oy.toFixed(4)
  }
  return d
}

/** 点在图标/文字上时,向上找到真正可交互的那个元素 */
const INTERACTIVE_SEL = 'a,button,input,select,textarea,label,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[tabindex]'

function liftToInteractive(el) {
  if (el.matches && el.matches(INTERACTIVE_SEL)) return el
  const up = el.closest && el.closest(INTERACTIVE_SEL)
  // 只往上找 4 层,再远就不是"点的那个东西"了
  if (up && depthBetween(el, up) <= 4) return up
  return el
}

function depthBetween(child, ancestor) {
  let n = 0
  let cur = child
  while (cur && cur !== ancestor && n < 32) { cur = cur.parentElement; n++ }
  return cur === ancestor ? n : Infinity
}

function pickTestAttr(el) {
  if (!el.getAttribute) return null
  for (const attr of TEST_ATTRS) {
    const v = el.getAttribute(attr)
    if (v) return { attr, value: v }
  }
  return null
}

function implicitRole(el) {
  const tag = el.tagName.toLowerCase()
  if (tag === 'button') return 'button'
  if (tag === 'a' && el.getAttribute('href')) return 'link'
  if (tag === 'input') {
    const t = (el.getAttribute('type') || 'text').toLowerCase()
    if (t === 'submit' || t === 'button') return 'button'
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    return 'textbox'
  }
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  return null
}

function normalizeText(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max || 64) : null
}

function stableClasses(el) {
  if (!el.classList) return []
  return Array.from(el.classList).filter(isStableClass).slice(0, 4)
}

/**
 * 生成一条 CSS 路径。锚点优先:一旦向上碰到稳定 id / testid 就停,
 * 这样页面顶部多插一个 banner 也不会让整条路径失效。
 */
function cssPath(el, maxDepth = 8) {
  const parts = []
  let cur = el
  let depth = 0
  while (cur && cur.nodeType === 1 && depth < maxDepth) {
    if (isStableId(cur.id)) { parts.unshift('#' + cssEscape(cur.id)); return parts.join(' > ') }
    const ta = pickTestAttr(cur)
    if (ta) { parts.unshift('[' + ta.attr + '="' + cssEscape(ta.value) + '"]'); return parts.join(' > ') }

    const tag = cur.tagName.toLowerCase()
    const parent = cur.parentElement
    if (!parent) { parts.unshift(tag); break }
    const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName)
    parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')' : tag)
    cur = parent
    depth++
  }
  return parts.join(' > ')
}

/* ---------------------------------------------------------------- 解析(从机侧) */

function qa(root, sel) {
  try { return Array.from(root.querySelectorAll(sel)) } catch (e) { return [] }
}

function textOf(e, max) {
  return normalizeText(e.innerText || e.textContent || '', max || 64)
}

/**
 * 定位策略,按可靠性从高到低。每条返回候选元素数组。
 * 唯一命中的高优先级策略直接采用;多义或落空就往下走。
 */
const STRATEGIES = [
  { name: 'id', weight: 100, run: (d, root) => d.id ? qa(root, '#' + cssEscape(d.id)) : [] },
  { name: 'testAttr', weight: 95, run: (d, root) => d.testAttr ? qa(root, '[' + d.testAttr.attr + '="' + cssEscape(d.testAttr.value) + '"]') : [] },
  { name: 'name', weight: 80, run: (d, root) => d.name ? qa(root, d.tag + '[name="' + cssEscape(d.name) + '"]') : [] },
  { name: 'ariaLabel', weight: 78, run: (d, root) => d.ariaLabel ? qa(root, '[aria-label="' + cssEscape(d.ariaLabel) + '"]') : [] },
  { name: 'roleText', weight: 70, run: (d, root) => {
      if (!d.text || !d.role) return []
      return qa(root, '[role="' + cssEscape(d.role) + '"], ' + d.tag).filter(e => textOf(e) === d.text)
    } },
  { name: 'exactText', weight: 65, run: (d, root) => {
      if (!d.text) return []
      return qa(root, d.tag).filter(e => textOf(e) === d.text)
    } },
  { name: 'href', weight: 60, run: (d, root) => (d.tag === 'a' && d.href) ? qa(root, 'a[href="' + cssEscape(d.href) + '"]') : [] },
  { name: 'path', weight: 50, run: (d, root) => d.path ? qa(root, d.path) : [] },
  { name: 'classText', weight: 40, run: (d, root) => {
      if (!d.classes || !d.classes.length) return []
      const sel = d.tag + d.classes.map(c => '.' + cssEscape(c)).join('')
      const hits = qa(root, sel)
      return d.text ? hits.filter(e => textOf(e) === d.text) : hits
    } },
  { name: 'fuzzyText', weight: 25, run: (d, root) => {
      if (!d.text || d.text.length < 2) return []
      const needle = d.text.toLowerCase()
      return qa(root, 'a,button,input,[role=button],[role=link],[onclick]').filter(e => {
        const t = normalizeText(e.innerText || e.textContent || e.value || '', 64)
        return t && t.toLowerCase().indexOf(needle) !== -1
      })
    } },
]

const MAX_WEIGHT = STRATEGIES.reduce((s, x) => s + x.weight, 0)

/**
 * 走投票路径时,第一名至少要比第二名高出这么多票才算"选得出来"。
 * 取值 = 最弱策略的权重,含义是:领先幅度至少得相当于多命中了一条独立策略。
 */
const VOTE_MARGIN = Math.min.apply(null, STRATEGIES.map(s => s.weight))

const FORM_CONTROL = /^(input|select|textarea|button)$/i

/**
 * 元素当前是否真的可以点。
 *
 * ⚠️ 这里有个反直觉但非常关键的判断:**`opacity:0` 不等于不能点。**
 * 自定义单选/复选的标准做法就是把真正的 <input> 设成 opacity:0 铺在样式化的 <label> 上,
 * 点击照样落在 input 上。apple.com.cn 的颜色/容量选项就是这么写的
 * (`<input type=radio data-autom="dimensionColorblack">`,opacity:0、36×36、pointer-events:auto)。
 * 早先把 opacity 0 一律判为不可点,导致在 Apple 实站上 waitFor 永远等不到、整条剧本卡死。
 *
 * 所以规则收紧为:真正决定能不能点的是 **有没有尺寸 + pointer-events 是否放行 + 有没有被隐藏**;
 * 透明只对"非表单控件"才算隐藏信号。
 */
function isActionable(el, win) {
  if (!el || !el.getBoundingClientRect) return false
  if (el.disabled === true) return false
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return false
  const style = win.getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (style.pointerEvents === 'none') return false
  if (Number(style.opacity) === 0) {
    // 透明的表单控件(或带 label 的元素)是"隐形但可点"的常见写法,放行;
    // 其它透明元素当作隐藏处理。
    const isControl = FORM_CONTROL.test(el.tagName) || !!labelFor(el)
    if (!isControl) return false
  }
  return true
}

/** 找到和这个表单控件关联的 <label>(for= 或祖先 label) */
function labelFor(el) {
  if (!el || !el.ownerDocument) return null
  try {
    if (el.id) {
      const l = el.ownerDocument.querySelector('label[for="' + cssEscape(el.id) + '"]')
      if (l) return l
    }
  } catch (e) { /* id 可能不合法 */ }
  return el.closest ? el.closest('label') : null
}

/**
 * 决定"这一下到底该打在哪个元素上"。
 *
 * 控件本身透明或者小到点不准时,改打它的 <label> —— 这也正是真人的做法。
 * Apple 的颜色块 label 和 input 恰好同位置同尺寸,但很多站点会把 input 缩成 1×1 塞到角落,
 * 那种情况下不改打 label 就必然点空。
 */
function clickTargetFor(el, win) {
  if (!el) return el
  const r = el.getBoundingClientRect()
  const style = win.getComputedStyle(el)
  const transparent = Number(style.opacity) === 0
  const tiny = r.width < 4 || r.height < 4
  if (!transparent && !tiny) return el
  const label = labelFor(el)
  if (label && isActionable(label, win)) {
    const lr = label.getBoundingClientRect()
    if (lr.width >= 4 && lr.height >= 4) return label
  }
  return el
}

function needsScroll(r, win) {
  return r.bottom < 0 || r.top > win.innerHeight || r.right < 0 || r.left > win.innerWidth
}

/**
 * 在当前文档里找回 descriptor 描述的元素,并算出该打哪个 CSS 坐标。
 *
 * @param {object} d descriptor
 * @param {Document} doc
 * @param {object} [opts] { autoScroll=true }
 * @returns {{ok:boolean, reason?:string, strategy?:string, confidence?:number,
 *            cssX?:number, cssY?:number, element?:Element, candidates?:number}}
 */
function resolve(d, doc, opts = {}) {
  if (!d) return { ok: false, reason: 'no-descriptor' }
  const win = doc.defaultView

  // 跑完所有策略,统计"哪个元素被几种策略同时指认" —— 多策略一致 = 高置信
  const votes = new Map()
  let best = null
  let conflicts = 0
  for (const s of STRATEGIES) {
    let hits
    try { hits = s.run(d, doc) } catch (e) { continue }
    if (!hits || !hits.length) continue
    const actionable = hits.filter(e => isActionable(e, win))
    const pool = actionable.length ? actionable : hits
    for (const e of pool) votes.set(e, (votes.get(e) || 0) + s.weight)
    // 唯一命中才算这条策略"说得准";多义的只贡献投票、不直接当选
    if (pool.length === 1) {
      if (!best) best = { el: pool[0], strategy: s.name, weight: s.weight }
      else if (best.el !== pool[0]) conflicts++   // 两条策略各自唯一命中了不同元素 —— 记下来降置信
    }
  }

  if (!votes.size) return { ok: false, reason: 'not-found' }

  if (!best) {
    // 没有任何策略唯一命中,只能看投票。但"票数最高"还不够 ——
    // 页面上三个按钮都叫「立即抢购」时它们票数完全相同,此时挑第一个就是在瞎点。
    const ranked = Array.from(votes.entries()).sort((x, y) => y[1] - x[1])
    const top = ranked[0]
    const runnerUp = ranked[1]
    // 得票过低说明只有 fuzzyText 之类的弱策略命中,不可信
    if (!top || top[1] < 50) return { ok: false, reason: 'ambiguous', candidates: votes.size }
    // 第一名必须明显甩开第二名,否则就是并列 —— 宁可降级也不要乱点
    if (runnerUp && top[1] - runnerUp[1] < VOTE_MARGIN) {
      return { ok: false, reason: 'ambiguous', candidates: votes.size, topScore: top[1], runnerUpScore: runnerUp[1] }
    }
    best = { el: top[0], strategy: 'vote', weight: top[1] }
  }

  const el = best.el
  const totalWeight = votes.get(el) || best.weight

  // 尺寸合理性校验:主机上是 120×40 的按钮,从机上找到个 4×4 的东西,多半找错了
  let sizePenalty = 0
  const r0 = el.getBoundingClientRect()
  if (d.size && d.size.w > 0 && d.size.h > 0 && r0.width > 0 && r0.height > 0) {
    const ratio = Math.max(r0.width / d.size.w, d.size.w / r0.width, r0.height / d.size.h, d.size.h / r0.height)
    if (ratio > 4) sizePenalty = 0.35
    else if (ratio > 2) sizePenalty = 0.15
  }

  if (opts.autoScroll !== false && needsScroll(r0, win)) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch (e) { el.scrollIntoView(true) }
  }

  // 透明/过小的控件改打它的 label(Apple 的颜色容量选项就是这种写法)
  const clickEl = clickTargetFor(el, win)

  // 滚动之后必须重新量,否则拿到的是滚动前的坐标
  const r = clickEl.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return { ok: false, reason: 'zero-size', strategy: best.strategy }

  const off = d.offset || { x: 0.5, y: 0.5 }
  const cssX = r.left + r.width * off.x
  const cssY = r.top + r.height * off.y

  // 落点仍在视口外(比如被 position:fixed 的遮罩推走了),不要发注入,交给上层降级
  if (cssX < 0 || cssY < 0 || cssX > win.innerWidth || cssY > win.innerHeight) {
    return { ok: false, reason: 'offscreen', strategy: best.strategy }
  }

  // 策略之间互相打架时,即使选出来了也要把置信度压下去,让上层有机会降级或告警
  const conflictPenalty = Math.min(0.5, conflicts * 0.25)
  const confidence = Math.max(0, Math.min(1, (totalWeight / MAX_WEIGHT) * 2.2 - sizePenalty - conflictPenalty))
  return {
    ok: true,
    strategy: best.strategy,
    confidence: +confidence.toFixed(3),
    candidates: votes.size,
    conflicts: conflicts,
    cssX: +cssX.toFixed(2),
    cssY: +cssY.toFixed(2),
    element: el,
    clickElement: clickEl,
    retargetedToLabel: clickEl !== el,
    actionable: isActionable(clickEl, win),
  }
}

const api = {
  describe, resolve, cssPath, normalizeText,
  isStableId, isStableClass, isActionable, liftToInteractive,
  labelFor, clickTargetFor,
  STRATEGIES, TEST_ATTRS, MAX_WEIGHT, VOTE_MARGIN,
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.AppleGoLocator = api
