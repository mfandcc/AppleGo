'use strict'
const { test } = require('node:test')
const a = require('node:assert')
const c = require('../src/main/core/InputCodec.js')

test('zoom 换算:sendInputEvent 收的是 view 物理坐标(实测 #9)', () => {
  a.deepStrictEqual(c.toViewCoords(110, 100, 0.5), { x: 55, y: 50 })
  a.deepStrictEqual(c.toViewCoords(110, 100, 1), { x: 110, y: 100 })
  a.deepStrictEqual(c.toViewCoords(110, 100, 2), { x: 220, y: 200 })
  a.deepStrictEqual(c.toViewCoords(110, 100), { x: 110, y: 100 }, '缺省 zoom 视为 1')
  a.deepStrictEqual(c.toViewCoords(110, 100, 0), { x: 110, y: 100 }, 'zoom=0 要退化成 1,不能把坐标归零')
  a.deepStrictEqual(c.toViewCoords(110, 100, NaN), { x: 110, y: 100 })
})

test('toCssCoords 是 toViewCoords 的逆运算', () => {
  a.deepStrictEqual(c.toCssCoords(55, 50, 0.5), { x: 110, y: 100 })
})

test('单击序列:先 move 再 down/up', () => {
  const seq = c.encode({ kind: 'mouse', action: 'click', cssX: 110, cssY: 100, button: 0, clickCount: 1 }, { zoomFactor: 0.5 })
  a.deepStrictEqual(seq.map(e => e.type), ['mouseMove', 'mouseDown', 'mouseUp'])
  a.strictEqual(seq[1].x, 55)
  a.strictEqual(seq[1].y, 50)
  a.strictEqual(seq[1].button, 'left')
})

test('双击必须补一组 clickCount:2(实测 #3)', () => {
  const seq = c.encode({ kind: 'mouse', action: 'click', cssX: 10, cssY: 10, button: 0, clickCount: 2 }, {})
  a.deepStrictEqual(
    seq.map(e => e.type + ':' + (e.clickCount || '')),
    ['mouseMove:', 'mouseDown:1', 'mouseUp:1', 'mouseDown:2', 'mouseUp:2']
  )
})

test('语义定位算出的落点覆盖主机坐标', () => {
  const seq = c.encode({ kind: 'mouse', action: 'click', cssX: 999, cssY: 999 }, { zoomFactor: 2, cssX: 10, cssY: 20 })
  a.strictEqual(seq[1].x, 20)
  a.strictEqual(seq[1].y, 40)
})

test('右键走 contextMenu 序列', () => {
  const seq = c.encode({ kind: 'mouse', action: 'contextmenu', cssX: 5, cssY: 5, button: 2 }, {})
  a.deepStrictEqual(seq.map(e => e.button), ['right', 'right', 'right'])
})

test('缺坐标时不产出事件,不能打到 (0,0)', () => {
  a.deepStrictEqual(c.encode({ kind: 'mouse', action: 'click' }, {}), [])
  a.deepStrictEqual(c.encode({ kind: 'wheel', deltaY: 100 }, {}), [])
})

test('键盘默认只放行导航键,避免把主机账号敲进从机', () => {
  a.strictEqual(c.encode({ kind: 'key', action: 'down', key: 'a' }, {}).length, 0)
  a.deepStrictEqual(c.encode({ kind: 'key', action: 'down', key: 'a' }, { allowTextKeys: true }).map(e => e.type), ['keyDown', 'char'])
})

test('Enter 之类不补 char,否则会被重复触发', () => {
  a.deepStrictEqual(c.encode({ kind: 'key', action: 'down', key: 'Enter' }, {}).map(e => e.type), ['keyDown'])
  a.deepStrictEqual(c.encode({ kind: 'key', action: 'up', key: 'Enter' }, {}).map(e => e.type), ['keyUp'])
})

test('DOM 键名映射到 Electron Accelerator', () => {
  a.strictEqual(c.toAcceleratorKey('ArrowDown'), 'Down')
  a.strictEqual(c.toAcceleratorKey('ArrowUp'), 'Up')
  a.strictEqual(c.toAcceleratorKey(' '), 'Space')
  a.strictEqual(c.toAcceleratorKey('Escape'), 'Esc')
  a.strictEqual(c.toAcceleratorKey('F5'), 'F5')
  a.strictEqual(c.toAcceleratorKey('Shift'), null, '单独按下的修饰键不同步')
  a.strictEqual(c.toAcceleratorKey('Dead'), null)
  a.strictEqual(c.toAcceleratorKey(''), null)
  a.strictEqual(c.toAcceleratorKey(undefined), null)
})

test('Space 的 char 要发真空格而不是字面量 "Space"', () => {
  const seq = c.encode({ kind: 'key', action: 'down', key: ' ' }, {})
  a.strictEqual(seq[0].keyCode, 'Space')
  a.strictEqual(seq[1].keyCode, ' ')
})

test('修饰键与拖拽按键状态', () => {
  a.deepStrictEqual(c.toModifiers({ shiftKey: true, metaKey: true }, { buttons: 1 }), ['shift', 'meta', 'leftbuttondown'])
  a.deepStrictEqual(c.toModifiers({ ctrlKey: true, altKey: true }), ['control', 'alt'])
  a.deepStrictEqual(c.toModifiers(null), [])
})

test('滚轮方向要取反:DOM deltaY>0 向下,Electron deltaY 正数向上', () => {
  const w = c.encode({ kind: 'wheel', cssX: 10, cssY: 10, deltaY: 120, deltaMode: 0 }, {})[0]
  a.strictEqual(w.deltaY, -120)
  a.strictEqual(w.wheelTicksY, -1)
  a.strictEqual(w.canScroll, true)
})

test('滚轮 deltaMode 行/页要折算成像素', () => {
  a.strictEqual(c.encode({ kind: 'wheel', cssX: 1, cssY: 1, deltaY: 3, deltaMode: 1 }, {})[0].deltaY, -99)
  a.strictEqual(c.encode({ kind: 'wheel', cssX: 1, cssY: 1, deltaY: 1, deltaMode: 2 }, {})[0].deltaY, -400)
})

test('逐字符输入文本', () => {
  a.deepStrictEqual(
    c.encode({ kind: 'text', text: 'hi' }, {}).map(e => e.type),
    ['keyDown', 'char', 'keyUp', 'keyDown', 'char', 'keyUp']
  )
  a.deepStrictEqual(c.encode({ kind: 'text', text: '' }, {}), [])
  a.deepStrictEqual(c.encode({ kind: 'text' }, {}), [])
})

test('未知事件类型静默返回空数组', () => {
  a.deepStrictEqual(c.encode({ kind: 'nope' }, {}), [])
  a.deepStrictEqual(c.encode({ kind: 'mouse', action: 'nope', cssX: 1, cssY: 1 }, {}), [])
})

test('滚轮 delta 也要乘 zoom(实测 #13:delta 和坐标走同一套换算)', () => {
  a.strictEqual(c.toViewDelta(120, 0.5), 60)
  a.strictEqual(c.toViewDelta(120, 1), 120)
  a.strictEqual(c.toViewDelta(120, 0), 120, 'zoom=0 退化成 1')

  // zoom=0.539(Apple 网格的典型值):透传 delta 会让从机多滚 1.85 倍
  const w = c.encode({ kind: 'wheel', cssX: 100, cssY: 100, deltaY: 120, deltaMode: 0 }, { zoomFactor: 0.5 })[0]
  a.strictEqual(w.deltaY, -60, 'CSS 120px 的滚动,在 zoom 0.5 下要发 60 的物理 delta')
  a.strictEqual(w.wheelTicksY, -0.5)
})

test('滚轮坐标与 delta 用同一个 zoom', () => {
  const w = c.encode({ kind: 'wheel', cssX: 200, cssY: 300, deltaY: 240, deltaMode: 0 }, { zoomFactor: 0.25 })[0]
  a.strictEqual(w.x, 50)
  a.strictEqual(w.y, 75)
  a.strictEqual(w.deltaY, -60)
})
