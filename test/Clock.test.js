'use strict'
const { test } = require('node:test')
const a = require('node:assert')
const { Clock } = require('../src/main/core/Clock.js')

/** 用模拟时钟跑一轮校准,返回 Clock 实例 */
function simulate({ trueOffset, rtt, samples, adaptive }) {
  let t = 1_000_000
  const c = new Clock({ nowImpl: () => t })
  for (let i = 0; i < samples; i++) {
    const sentAt = t
    t += rtt / 2
    const serverSec = Math.floor((t + trueOffset) / 1000) * 1000   // Date 头只有秒级
    t += rtt / 2
    c.observe(serverSec, sentAt, t)
    t += adaptive ? Math.max(20, c.planNextSampleDelay(t, i)) : (71 + (i % 5) * 37)
  }
  return c
}

test('区间收敛:真值必须始终落在可行区间内', () => {
  for (const trueOffset of [0, 437, -1234, 15999]) {
    const c = simulate({ trueOffset, rtt: 40, samples: 16, adaptive: true })
    a.ok(c.lo <= trueOffset && trueOffset < c.hi, `offset=${trueOffset} 落在 [${c.lo}, ${c.hi}) 外`)
  }
})

test('自适应取样明显优于固定相位,并逼近 RTT/2 的理论下界', () => {
  const RTT = 40
  const fixed = simulate({ trueOffset: 437, rtt: RTT, samples: 20, adaptive: false })
  const adapt = simulate({ trueOffset: 437, rtt: RTT, samples: 20, adaptive: true })
  a.ok(adapt.uncertaintyMs < fixed.uncertaintyMs, `自适应 ±${adapt.uncertaintyMs} 应优于固定 ±${fixed.uncertaintyMs}`)
  a.ok(adapt.uncertaintyMs <= RTT / 2 + 5, `应收敛到 RTT/2 量级,实际 ±${adapt.uncertaintyMs}`)
  a.ok(Math.abs(adapt.offsetMs - 437) <= RTT / 2 + 5)
})

test('高 RTT + 少样本仍然正确,只是更宽', () => {
  const RTT = 80
  const c = simulate({ trueOffset: -1234, rtt: RTT, samples: 8, adaptive: true })
  a.ok(c.lo <= -1234 && -1234 < c.hi)
  a.ok(c.uncertaintyMs <= RTT + 10, `实际 ±${c.uncertaintyMs}`)
})

test('单个样本只能给出 ±500ms', () => {
  const c = new Clock({ nowImpl: () => 0 })
  c.observe(1000, 0, 0)
  a.strictEqual(c.uncertaintyMs, 500)
})

test('未校准时 offset 为 0、不确定度为 Infinity、snapshot.synced 为 false', () => {
  const c = new Clock({ nowImpl: () => 0 })
  a.strictEqual(c.offsetMs, 0)
  a.strictEqual(c.uncertaintyMs, Infinity)
  a.strictEqual(c.snapshot().synced, false)
  a.strictEqual(c.snapshot().uncertaintyMs, null)
})

test('非法样本不污染区间', () => {
  const c = new Clock({ nowImpl: () => 0 })
  a.strictEqual(c.observe('not-a-date', 0, 1), false)
  a.strictEqual(c.observe(NaN, 0, 1), false)
  a.strictEqual(c.observe(1000, 10, 0), false, 'receivedAt < sentAt 必须拒绝')
  a.strictEqual(c.sampleCount, 0)
})

test('矛盾样本(系统校时跳变)重开区间而不是死锁', () => {
  const c = new Clock({ nowImpl: () => 0 })
  c.observe(1000, 0, 10)
  c.observe(99_000, 0, 10)
  a.strictEqual(c.sampleCount, 1)
  a.ok(Number.isFinite(c.offsetMs))
})

test('reset 回到未校准状态', () => {
  const c = new Clock({ nowImpl: () => 0 })
  c.observe(1000, 0, 10)
  c.reset()
  a.strictEqual(c.sampleCount, 0)
  a.strictEqual(c.uncertaintyMs, Infinity)
})

test('toLocal / now 随 offset 平移', () => {
  let t = 5000
  const c = new Clock({ nowImpl: () => t })
  c.lo = 200; c.hi = 200; c.sampleCount = 1
  a.strictEqual(c.offsetMs, 200)
  a.strictEqual(c.now(), 5200)
  a.strictEqual(c.toLocal(5200), 5000)
})

test('scheduleAt 在目标时刻触发,且 cancel 有效', async () => {
  const c = new Clock()
  const t0 = Date.now()
  const fired = await new Promise(resolve => {
    c.scheduleAt(c.now() + 150, () => resolve(Date.now() - t0))
  })
  a.ok(fired >= 145 && fired < 400, `应在 ~150ms 触发,实际 ${fired}ms`)
})

test('scheduleAt 的 leadMs 提前量生效', async () => {
  const c = new Clock()
  const t0 = Date.now()
  const fired = await new Promise(resolve => {
    c.scheduleAt(c.now() + 200, () => resolve(Date.now() - t0), { leadMs: 120 })
  })
  a.ok(fired >= 70 && fired < 200, `应提前到 ~80ms 触发,实际 ${fired}ms`)
})

test('cancel 之后不再触发', async () => {
  const c = new Clock()
  let fired = false
  const h = c.scheduleAt(c.now() + 60, () => { fired = true })
  h.cancel()
  await new Promise(r => setTimeout(r, 160))
  a.strictEqual(fired, false)
})

test('scheduleAt 里 fn 抛错不会打穿调用方', async () => {
  const logs = []
  const c = new Clock({ log: (lvl, msg) => logs.push(lvl) })
  c.scheduleAt(c.now() + 20, () => { throw new Error('boom') })
  await new Promise(r => setTimeout(r, 140))
  a.ok(logs.includes('error'))
})

test('偶发的矛盾样本被丢弃,不推翻已收敛的区间', () => {
  let t = 1_000_000
  const c = new Clock({ nowImpl: () => t })
  for (let i = 0; i < 12; i++) {
    const sentAt = t; t += 20
    c.observe(Math.floor((t + 400) / 1000) * 1000, sentAt, t + 20)
    t += Math.max(20, c.planNextSampleDelay(t, i))
  }
  const before = c.offsetMs
  const width = c.uncertaintyMs
  // 混进来一条别的服务器的响应
  a.strictEqual(c.observe(99_000_000, t, t + 10), false, '杂样本应被丢弃')
  a.strictEqual(c.offsetMs, before, '已收敛的估计不能被一条杂样本毁掉')
  a.strictEqual(c.uncertaintyMs, width)
})

test('连续矛盾才判定为时钟跳变并重开区间', () => {
  const c = new Clock({ nowImpl: () => 0 })
  c.observe(1000, 0, 10)
  c.observe(99_000, 0, 10)
  c.observe(99_000, 0, 10)
  a.ok(c.sampleCount >= 1)
  const r = c.observe(99_000, 0, 10)
  a.strictEqual(r, true, '第三条连续矛盾应触发重置')
  a.strictEqual(c.sampleCount, 1)
})
