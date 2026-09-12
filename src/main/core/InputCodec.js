'use strict'
/**
 * InputCodec —— 主从同步的"翻译层"。
 *
 * 把主机页面里捕获到的一次用户输入(已归一化的 SyncEvent),翻译成要发给某个从机
 * WebContentsView 的 Electron 输入事件序列。
 *
 * 这一层的全部坐标规则来自实测(docs/EMPIRICAL-PROBE.md):
 *   - sendInputEvent 的 x/y 相对 **WebContentsView 自身左上角**,与 view 在窗口里的位置无关(实测 #1)
 *   - sendInputEvent 收的是 **view 物理坐标(DIP)**,页面 clientX = x / zoomFactor(实测 #9)
 *     => viewX = cssX * zoomFactor          <-- 整个项目唯一允许做这个换算的地方
 *   - 注入事件 isTrusted 为 true(实测 #2)
 *   - 双击 = clickCount:1 的 down/up 之后再来一组 clickCount:2 的 down/up(实测 #3)
 *   - keyDown -> char -> keyUp 才能真正输入字符(实测 #5)
 *
 * 本文件是纯函数,不 require electron,可以直接用 node 跑测试。
 */

/** DOM MouseEvent.button -> Electron button 名 */
const BUTTON_BY_INDEX = ['left', 'middle', 'right']

/** DOM 修饰键 -> Electron modifiers 取值 */
const MODIFIER_FLAGS = [
  ['shiftKey', 'shift'],
  ['ctrlKey', 'control'],
  ['altKey', 'alt'],
  ['metaKey', 'meta'],
]

/**
 * DOM KeyboardEvent.key -> Electron Accelerator keyCode。
 * Electron 只认 Accelerator 里的名字,和 DOM 的命名有几处不一样(方向键、空格)。
 */
const KEY_ALIASES = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Spacebar: 'Space',
  Escape: 'Esc',
  Del: 'Delete',
  Add: 'numadd',
  Subtract: 'numsub',
  Multiply: 'nummult',
  Divide: 'numdiv',
}

/** 这些键是"导航/功能键",安全模式下只同步它们,不同步会产生文本的按键 */
const NAVIGATION_KEYS = new Set([
  'Tab', 'Enter', 'Esc', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
])

/** 把 DOM 事件里的修饰键状态翻译成 Electron modifiers 数组 */
function toModifiers(src, { buttons = 0 } = {}) {
  const out = []
  for (const [domFlag, electronName] of MODIFIER_FLAGS) {
    if (src && src[domFlag]) out.push(electronName)
  }
  // 拖拽时必须带上按键按下状态,否则 Chromium 不认为这是一次拖动
  if (buttons & 1) out.push('leftbuttondown')
  if (buttons & 4) out.push('middlebuttondown')
  if (buttons & 2) out.push('rightbuttondown')
  return out
}

/** DOM key -> Electron Accelerator keyCode。返回 null 表示这个键没法同步。 */
function toAcceleratorKey(domKey) {
  if (typeof domKey !== 'string' || domKey.length === 0) return null
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, domKey)) return KEY_ALIASES[domKey]
  if (domKey.length === 1) return domKey                  // 可打印字符,原样给
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(domKey)) return domKey
  if (/^(Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Escape)$/.test(domKey)) {
    return domKey === 'Escape' ? 'Esc' : domKey
  }
  return null   // Shift/Control/Alt/Meta/CapsLock/Dead/Process… 单独按下的修饰键不单独同步
}

function isNavigationKey(acceleratorKey) {
  return NAVIGATION_KEYS.has(acceleratorKey)
}

/**
 * 页面 CSS 坐标 -> view 物理坐标。
 * 全项目唯一的 zoom 换算点,任何地方都不许再裸算一遍。
 */
function toViewCoords(cssX, cssY, zoomFactor = 1) {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return { x: Math.round(cssX * z), y: Math.round(cssY * z) }
}

/**
 * 页面 CSS 位移 -> view 物理位移。
 *
 * 实测 #13:mouseWheel 的 deltaX/deltaY 和坐标走同一套换算 —— 页面收到的值 = 发送值 / zoomFactor。
 * 所以要让从机滚动和主机相同的 CSS 距离,必须先把 CSS 位移乘回 zoom。
 * 直接透传 delta 的话,zoom=0.539 时从机会多滚 1.85 倍。
 */
function toViewDelta(cssDelta, zoomFactor = 1) {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return cssDelta * z
}

/** view 物理坐标 -> 页面 CSS 坐标(回读、调试用) */
function toCssCoords(viewX, viewY, zoomFactor = 1) {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return { x: viewX / z, y: viewY / z }
}

/**
 * 核心:SyncEvent -> Electron 输入事件序列。
 *
 * @param {object} ev  归一化后的同步事件(见 docs 里的 SyncEvent 定义)
 * @param {object} target
 *   @param {number} target.zoomFactor  该从机的 zoomFactor
 *   @param {number} [target.cssX]      语义定位算出来的落点(页面 CSS 坐标)。给了就用它覆盖 ev 的坐标。
 *   @param {number} [target.cssY]
 *   @param {boolean} [target.allowTextKeys] 是否允许同步会产生文本的按键(默认 false,只同步导航键)
 * @returns {Array<object>} 可直接喂给 webContents.sendInputEvent 的事件数组(顺序有意义)
 */
function encode(ev, target = {}) {
  const zoom = target.zoomFactor == null ? 1 : target.zoomFactor
  const cssX = target.cssX != null ? target.cssX : ev.cssX
  const cssY = target.cssY != null ? target.cssY : ev.cssY

  switch (ev.kind) {
    case 'mouse':    return encodeMouse(ev, cssX, cssY, zoom)
    case 'wheel':    return encodeWheel(ev, cssX, cssY, zoom)
    case 'key':      return encodeKey(ev, target.allowTextKeys === true)
    case 'text':     return encodeText(ev)
    default:         return []
  }
}

function encodeMouse(ev, cssX, cssY, zoom) {
  if (cssX == null || cssY == null) return []
  const { x, y } = toViewCoords(cssX, cssY, zoom)
  const button = BUTTON_BY_INDEX[ev.button] || 'left'
  const modifiers = toModifiers(ev, { buttons: ev.buttons })
  const base = { x, y, button, modifiers }

  switch (ev.action) {
    case 'move':
      return [{ type: 'mouseMove', ...base, movementX: ev.movementX, movementY: ev.movementY }]

    case 'down':
      return [{ type: 'mouseDown', ...base, clickCount: ev.clickCount || 1 }]

    case 'up':
      return [{ type: 'mouseUp', ...base, clickCount: ev.clickCount || 1 }]

    case 'contextmenu':
      return [
        { type: 'mouseMove', ...base },
        { type: 'mouseDown', ...base, button: 'right', clickCount: 1 },
        { type: 'mouseUp', ...base, button: 'right', clickCount: 1 },
      ]

    // 一次完整点击。先 move 再 down/up —— 很多站点的按钮要先 hover 才会绑定/启用。
    case 'click': {
      const seq = [
        { type: 'mouseMove', ...base },
        { type: 'mouseDown', ...base, clickCount: 1 },
        { type: 'mouseUp', ...base, clickCount: 1 },
      ]
      // 双击:实测必须再补一组 clickCount:2,页面才会收到 dblclick
      if ((ev.clickCount || 1) >= 2) {
        seq.push({ type: 'mouseDown', ...base, clickCount: 2 })
        seq.push({ type: 'mouseUp', ...base, clickCount: 2 })
      }
      return seq
    }

    default:
      return []
  }
}

function encodeWheel(ev, cssX, cssY, zoom) {
  if (cssX == null || cssY == null) return []
  const { x, y } = toViewCoords(cssX, cssY, zoom)
  // DOM deltaMode: 0=像素 1=行 2=页。Electron 只吃像素,按 Chromium 的经验值折算。
  const scale = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1
  // 取负:DOM 的 deltaY>0 表示向下滚,Electron 的 deltaY 正数表示向上。
  // 再乘 zoom:delta 和坐标一样收的是 view 物理量(实测 #13)。
  const deltaX = toViewDelta(-(ev.deltaX || 0) * scale, zoom)
  const deltaY = toViewDelta(-(ev.deltaY || 0) * scale, zoom)
  return [{
    type: 'mouseWheel',
    x, y,
    deltaX, deltaY,
    wheelTicksX: deltaX / 120,
    wheelTicksY: deltaY / 120,
    modifiers: toModifiers(ev),
    canScroll: true,          // 实测不带也滚,显式带上防跨平台差异
  }]
}

function encodeKey(ev, allowTextKeys) {
  const keyCode = toAcceleratorKey(ev.key)
  if (!keyCode) return []
  if (!allowTextKeys && !isNavigationKey(keyCode)) return []

  const modifiers = toModifiers(ev)
  if (ev.action === 'down') {
    const seq = [{ type: 'keyDown', keyCode, modifiers }]
    // 只有会产生字符的键才需要 char,否则 Enter 之类会被重复触发
    if (keyCode.length === 1 || keyCode === 'Space') {
      seq.push({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : keyCode, modifiers })
    }
    return seq
  }
  if (ev.action === 'up') return [{ type: 'keyUp', keyCode, modifiers }]
  return []
}

/** 逐字符敲一段文本(变量填充的兜底路径,走真实按键而不是设 value) */
function encodeText(ev) {
  const text = String(ev.text == null ? '' : ev.text)
  const seq = []
  for (const ch of text) {
    const keyCode = toAcceleratorKey(ch)
    if (!keyCode) continue
    seq.push({ type: 'keyDown', keyCode })
    seq.push({ type: 'char', keyCode })
    seq.push({ type: 'keyUp', keyCode })
  }
  return seq
}

module.exports = {
  encode,
  toViewCoords,
  toViewDelta,
  toCssCoords,
  toModifiers,
  toAcceleratorKey,
  isNavigationKey,
  NAVIGATION_KEYS,
}
