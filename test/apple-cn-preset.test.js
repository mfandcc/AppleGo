'use strict'
const test = require('node:test')
const assert = require('node:assert')
const preset = require('../src/shared/presets/apple-cn')

test('iPhone Duo 机型存在且选项完整', () => {
  const m = preset.models['iphone-duo']
  assert.ok(m)
  assert.strictEqual(m.screensizes, null)
  assert.deepStrictEqual(m.colors.map(c => c.v), ['starwhite', 'nightsky'])
  assert.deepStrictEqual(m.capacities.map(c => c.v), ['256gb', '512gb', '1tb', '2tb'])
  assert.strictEqual(m.preorder.at, '2026-10-16T20:00:00+08:00')
})

test('iPhone Duo 配置页 URL 与剧本', () => {
  assert.strictEqual(preset.urls.buyModel('iphone-duo'), 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo')
  const pb = preset.buyPlaybook({ model: 'iphone-duo', color: 'nightsky', capacity: '1tb' })
  assert.strictEqual(pb.steps[0].url, 'https://www.apple.com.cn/shop/buy-iphone/iphone-duo')
  assert.ok(!pb.steps.some(s => s.selector && s.selector.includes('dimensionScreensize')))
  assert.ok(pb.steps.some(s => s.selector === '[data-autom="dimensionColornightsky"]'))
  assert.ok(pb.steps.some(s => s.selector === '[data-autom="dimensionCapacity1tb"]'))
})

test('iPhone Duo 首发预购计划取到预购时间', () => {
  const plan = preset.preorderPlan({ model: 'iphone-duo', screensize: null, color: 'starwhite', capacity: '256gb' })
  assert.strictEqual(plan.preorderAt, '2026-10-16T20:00:00+08:00')
  assert.ok(plan.playbook.steps.every(s => s.selector !== '[data-autom="add-to-cart"]'))
})

test('iPhone Duo 预购计划不带默认尺寸', () => {
  const plan = preset.preorderPlan({ model: 'iphone-duo', color: 'starwhite', capacity: '256gb' })
  assert.ok(!plan.playbook.steps.some(s => s.selector && s.selector.includes('dimensionScreensize')))
})
