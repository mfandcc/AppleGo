'use strict'
const { test } = require('node:test')
const a = require('node:assert')
const { SyncEngine, CONFIDENCE_FLOOR } = require('../src/main/core/SyncEngine.js')

/** 假 webContents:把收到的 sendInputEvent 记下来 */
function fakeWc() {
  return { sent: [], destroyed: false, isDestroyed() { return this.destroyed }, sendInputEvent(e) { this.sent.push(e) } }
}

/** 假 RPC:按 instanceId 返回预设的 resolve 结果 */
function fakeRpc(byInstance) {
  return {
    calls: [],
    call(wc, method, params) {
      this.calls.push({ wc, method, params })
      const r = byInstance.get(wc.__id)
      return Promise.resolve(typeof r === 'function' ? r(method, params) : r)
    },
  }
}

function makeEngine({ resolves = new Map(), n = 3, mode = 'auto' } = {}) {
  const instances = []
  for (let i = 1; i <= n; i++) {
    const wc = fakeWc(); wc.__id = i
    instances.push({ id: i, enabled: true, zoomFactor: 1, webContents: wc })
  }
  const records = []
  const engine = new SyncEngine({
    rpc: fakeRpc(resolves),
    getInstances: () => instances,
    onRecord: r => records.push(r),
  })
  engine.setMaster(1)
  engine.setMode(mode)
  engine.setEnabled(true)
  engine.mute(1, -1)   // 清掉 setMaster 造成的静默,方便测试
  engine._mute.clear()
  return { engine, instances, records }
}

const CLICK = {
  kind: 'mouse', action: 'click', cssX: 100, cssY: 200, button: 0, clickCount: 1,
  instanceId: 1,
  descriptor: { tag: 'button', id: 'buy', text: '立即抢购', offset: { x: 0.5, y: 0.5 }, size: { w: 100, h: 40 } },
}

test('主机的点击会分发到所有从机,主机自己不被注入', async () => {
  const resolves = new Map([[2, { ok: true, cssX: 50, cssY: 60, confidence: 0.9, strategy: 'id' }],
                           [3, { ok: true, cssX: 70, cssY: 80, confidence: 0.9, strategy: 'id' }]])
  const { engine, instances } = makeEngine({ resolves })
  const rec = await engine.handleMasterEvent(CLICK)
  a.strictEqual(rec.total, 2, '只有 2 台从机')
  a.strictEqual(rec.ok, 2)
  a.strictEqual(instances[0].webContents.sent.length, 0, '主机不能被注入')
  a.ok(instances[1].webContents.sent.length >= 3, '从机应收到 move+down+up')
})

test('语义解析出的坐标覆盖主机坐标', async () => {
  const resolves = new Map([[2, { ok: true, cssX: 50, cssY: 60, confidence: 0.9, strategy: 'id' }],
                           [3, { ok: true, cssX: 70, cssY: 80, confidence: 0.9, strategy: 'id' }]])
  const { engine, instances } = makeEngine({ resolves })
  await engine.handleMasterEvent(CLICK)
  const down2 = instances[1].webContents.sent.find(e => e.type === 'mouseDown')
  const down3 = instances[2].webContents.sent.find(e => e.type === 'mouseDown')
  a.deepStrictEqual([down2.x, down2.y], [50, 60])
  a.deepStrictEqual([down3.x, down3.y], [70, 80], '每台从机用自己算出来的落点,而不是抄主机的')
})

test('zoomFactor 参与换算', async () => {
  const resolves = new Map([[2, { ok: true, cssX: 100, cssY: 200, confidence: 0.9, strategy: 'id' }]])
  const { engine, instances } = makeEngine({ resolves, n: 2 })
  instances[1].zoomFactor = 0.5
  await engine.handleMasterEvent(CLICK)
  const down = instances[1].webContents.sent.find(e => e.type === 'mouseDown')
  a.deepStrictEqual([down.x, down.y], [50, 100], 'cssX × zoomFactor')
})

test('【闸门①②③】注入后的静默窗口挡住自激回声', async () => {
  const resolves = new Map([[2, { ok: true, cssX: 1, cssY: 1, confidence: 0.9 }]])
  const { engine, instances } = makeEngine({ resolves, n: 2 })
  await engine.handleMasterEvent(CLICK)
  a.ok(engine.isMuted(2), '被注入的实例应处于静默窗口内')
  // 从机把注入事件当用户事件报回来(isTrusted 为 true,它分不出),必须被丢弃
  const echo = { ...CLICK, instanceId: 2 }
  const r = await engine.handleMasterEvent(echo)
  a.strictEqual(r, null, '非主机来源的事件必须丢弃')
})

test('【闸门③】非主机实例的上报一律丢弃,即使没在静默窗口', async () => {
  const { engine } = makeEngine({ n: 3 })
  engine._mute.clear()
  a.strictEqual(await engine.handleMasterEvent({ ...CLICK, instanceId: 3 }), null)
})

test('主机自己在静默窗口内的上报也丢弃(切主机的竞态)', async () => {
  const { engine } = makeEngine({ n: 2 })
  engine.mute(1)
  a.strictEqual(await engine.handleMasterEvent(CLICK), null)
})

test('setMaster 会同时静默新旧主机', () => {
  const { engine } = makeEngine({ n: 3 })
  engine.setMaster(2)
  a.ok(engine.isMuted(1), '旧主机要静默,防止管道里的残留事件被当成新主机的')
  a.ok(engine.isMuted(2))
})

test('关闭同步后不再分发', async () => {
  const { engine, instances } = makeEngine({ n: 2 })
  engine.setEnabled(false)
  a.strictEqual(await engine.handleMasterEvent(CLICK), null)
  a.strictEqual(instances[1].webContents.sent.length, 0)
})

test('auto 模式:语义失败时降级到坐标同步', async () => {
  const resolves = new Map([[2, { ok: false, reason: 'not-found' }]])
  const { engine, instances } = makeEngine({ resolves, n: 2, mode: 'auto' })
  const rec = await engine.handleMasterEvent(CLICK)
  a.strictEqual(rec.results[0].ok, true)
  a.strictEqual(rec.results[0].degraded, true)
  a.strictEqual(rec.results[0].semanticReason, 'not-found')
  const down = instances[1].webContents.sent.find(e => e.type === 'mouseDown')
  a.deepStrictEqual([down.x, down.y], [100, 200], '降级后用主机坐标')
})

test('semantic 模式:语义失败就不点,宁可漏也不乱点', async () => {
  const resolves = new Map([[2, { ok: false, reason: 'ambiguous' }]])
  const { engine, instances } = makeEngine({ resolves, n: 2, mode: 'semantic' })
  const rec = await engine.handleMasterEvent(CLICK)
  a.strictEqual(rec.results[0].ok, false)
  a.strictEqual(rec.results[0].reason, 'ambiguous')
  a.strictEqual(instances[1].webContents.sent.length, 0, '一个事件都不该发出去')
})

test('置信度低于阈值按失败处理', async () => {
  const low = CONFIDENCE_FLOOR - 0.01
  const resolves = new Map([[2, { ok: true, cssX: 5, cssY: 5, confidence: low }]])
  const { engine, instances } = makeEngine({ resolves, n: 2, mode: 'semantic' })
  const rec = await engine.handleMasterEvent(CLICK)
  a.strictEqual(rec.results[0].ok, false)
  a.strictEqual(instances[1].webContents.sent.length, 0)
})

test('滚轮/移动走坐标路径,不做语义解析', async () => {
  const rpcCalls = []
  const { engine, instances } = makeEngine({ n: 2 })
  engine.rpc.call = (...args) => { rpcCalls.push(args[1]); return Promise.resolve({ ok: false }) }
  await engine.handleMasterEvent({ kind: 'wheel', instanceId: 1, cssX: 10, cssY: 10, deltaY: 120, deltaMode: 0 })
  a.strictEqual(rpcCalls.length, 0, '滚轮不该触发 RPC')
  a.strictEqual(instances[1].webContents.sent[0].type, 'mouseWheel')
})

test('已销毁的从机被跳过,不会拖垮整批', async () => {
  const resolves = new Map([[2, { ok: true, cssX: 1, cssY: 1, confidence: 0.9 }],
                           [3, { ok: true, cssX: 1, cssY: 1, confidence: 0.9 }]])
  const { engine, instances } = makeEngine({ resolves, n: 3 })
  instances[2].webContents.destroyed = true
  const rec = await engine.handleMasterEvent(CLICK)
  a.strictEqual(rec.total, 1, '销毁的实例不进分发列表')
  a.strictEqual(rec.ok, 1)
})

test('禁用的实例不参与同步', async () => {
  const resolves = new Map([[2, { ok: true, cssX: 1, cssY: 1, confidence: 0.9 }]])
  const { engine, instances } = makeEngine({ resolves, n: 3 })
  instances[2].enabled = false
  const rec = await engine.handleMasterEvent(CLICK)
  a.strictEqual(rec.total, 1)
})

test('sendInputEvent 抛错被兜住,不影响其它实例', async () => {
  const resolves = new Map([[2, { ok: true, cssX: 1, cssY: 1, confidence: 0.9 }],
                           [3, { ok: true, cssX: 1, cssY: 1, confidence: 0.9 }]])
  const { engine, instances } = makeEngine({ resolves, n: 3 })
  instances[1].webContents.sendInputEvent = () => { throw new Error('boom') }
  const rec = await engine.handleMasterEvent(CLICK)
  a.strictEqual(rec.ok, 1)
  a.strictEqual(rec.results.find(r => r.instanceId === 2).reason, 'send-failed')
})

test('预热 + 开火:开火时不再走 resolve', async () => {
  const resolves = new Map([
    [2, (method) => method === 'prime' ? { ok: true, cssX: 11, cssY: 22, strategy: 'id' }
                                       : { ok: true, cssX: 11, cssY: 22, strategy: 'id', moved: false }],
    [3, (method) => method === 'prime' ? { ok: true, cssX: 33, cssY: 44, strategy: 'id' }
                                       : { ok: true, cssX: 33, cssY: 44, strategy: 'id', moved: false }],
  ])
  const { engine, instances } = makeEngine({ resolves, n: 3 })
  const primed = await engine.prime('buy', CLICK.descriptor)
  a.strictEqual(primed.filter(p => p.ok).length, 2)

  const rec = await engine.fire('buy')
  a.strictEqual(rec.ok, 2)
  const down2 = instances[1].webContents.sent.find(e => e.type === 'mouseDown')
  a.deepStrictEqual([down2.x, down2.y], [11, 22])
  a.ok(engine.rpc.calls.every(c => c.method === 'prime' || c.method === 'getPrimed'), '开火路径不该调用 resolve')
})

test('没预热就开火会老实报错', async () => {
  const resolves = new Map([[2, { ok: false, reason: 'not-primed' }]])
  const { engine, instances } = makeEngine({ resolves, n: 2 })
  const rec = await engine.fire('never-primed')
  a.strictEqual(rec.ok, 0)
  a.strictEqual(rec.results[0].reason, 'not-primed')
  a.strictEqual(instances[1].webContents.sent.length, 0)
})

test('未知同步模式抛错', () => {
  const { engine } = makeEngine({ n: 2 })
  a.throws(() => engine.setMode('nonsense'), /未知同步模式/)
})

test('stats 反映实际分发情况', async () => {
  const resolves = new Map([[2, { ok: true, cssX: 1, cssY: 1, confidence: 0.9 }]])
  const { engine } = makeEngine({ resolves, n: 2 })
  await engine.handleMasterEvent(CLICK)
  const s = engine.stats()
  a.strictEqual(s.dispatched, 1)
  a.strictEqual(s.semantic, 1)
  a.strictEqual(s.slaveCount, 1)
  a.strictEqual(s.masterId, 1)
})

test('缩放优先按页面回报的 innerWidth 现算(消除测量滞后)', () => {
  const { zoomFor } = require('../src/main/core/SyncEngine.js')
  // 格子物理 640,页面说自己 1280 宽 -> 真实缩放 0.5
  a.strictEqual(zoomFor({ boundsW: 640, zoomFactor: 1 }, 1280), 0.5)
  // 页面没回报 vw 时退回实例自己测到的值
  a.strictEqual(zoomFor({ boundsW: 640, actualZoomFactor: () => 0.42 }, undefined), 0.42)
  a.strictEqual(zoomFor({ boundsW: 0, zoomFactor: 0.3 }, 1280), 0.3, '没有 boundsW 就不能现算')
  a.strictEqual(zoomFor({}, 0), 1)
})
