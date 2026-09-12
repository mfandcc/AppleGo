'use strict'
const { test } = require('node:test')
const a = require('node:assert')
const L = require('../src/shared/Locator.js')

test('稳定 id 判定', () => {
  a.strictEqual(L.isStableId('buy-now'), true)
  a.strictEqual(L.isStableId('globalnav-menubutton-link-bag'), true, 'Apple 的这个 id 是稳定的')
  a.strictEqual(L.isStableId('noTradeIn'), true)
})

test('框架生成的 id 必须判为不稳定', () => {
  a.strictEqual(L.isStableId(':r1:'), false, 'React 18 useId')
  a.strictEqual(L.isStableId(':R2ab:'), false)
  a.strictEqual(L.isStableId('_r_c_'), false, 'React 19 useId —— apple.com.cn 用的就是这个')
  a.strictEqual(L.isStableId('_r_14_'), false)
  a.strictEqual(L.isStableId('_r_1a_'), false)
  a.strictEqual(L.isStableId('radix-123'), false)
  a.strictEqual(L.isStableId('a1b2c3d4e5'), false)
  a.strictEqual(L.isStableId('item-12345'), false)
  a.strictEqual(L.isStableId(''), false)
  a.strictEqual(L.isStableId(null), false)
  a.strictEqual(L.isStableId('x'.repeat(80)), false)
})

test('data-autom 是最高优先级的测试属性(Apple 全站依赖它)', () => {
  a.strictEqual(L.TEST_ATTRS[0], 'data-autom')
  a.ok(L.TEST_ATTRS.includes('data-testid'))
})

test('稳定 class 判定', () => {
  a.strictEqual(L.isStableClass('btn-primary'), true)
  a.strictEqual(L.isStableClass('css-1x2y3z'), false)
  a.strictEqual(L.isStableClass('is-active'), false)
  a.strictEqual(L.isStableClass('btn--loading'), false)
  a.strictEqual(L.isStableClass('rf-hcard-content'), true, 'Apple 的语义类名应保留')
})

test('文本归一化', () => {
  a.strictEqual(L.normalizeText('  立即\n\n 抢购  '), '立即 抢购')
  a.strictEqual(L.normalizeText('   '), null)
  a.strictEqual(L.normalizeText(null), null)
  a.strictEqual(L.normalizeText('a'.repeat(100), 10), 'aaaaaaaaaa')
})

test('投票需要明显领先才作数(防止同名元素被瞎选)', () => {
  a.strictEqual(L.VOTE_MARGIN, 25)
  a.ok(L.MAX_WEIGHT > 600)
})
