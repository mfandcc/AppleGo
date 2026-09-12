'use strict'
const { test } = require('node:test')
const a = require('node:assert')
const T = require('../src/shared/time.js')

test('datetime-local 的值按北京时间解析,而不是本机时区', () => {
  const ts = T.parseBeijing('2026-09-12T20:00')
  a.strictEqual(new Date(ts).toISOString(), '2026-09-12T12:00:00.000Z', '北京 20:00 = UTC 12:00')
  a.strictEqual(ts, Date.parse('2026-09-12T20:00:00+08:00'))
})

test('本机在美西时,直接 new Date 会差 15 小时 —— 这正是要避免的', () => {
  const correct = T.parseBeijing('2026-09-12T20:00')
  const naive = new Date('2026-09-12T20:00').getTime()   // 按本机时区解释
  if (T.localTz() !== 'Asia/Shanghai') {
    a.notStrictEqual(correct, naive, '两者必须不同,否则说明解析走了本机时区')
  }
})

test('秒可选,空格分隔也认', () => {
  a.strictEqual(T.parseBeijing('2026-09-12T20:00:30'), Date.parse('2026-09-12T20:00:30+08:00'))
  a.strictEqual(T.parseBeijing('2026-09-12 20:00'), Date.parse('2026-09-12T20:00:00+08:00'))
})

test('非法输入返回 NaN 而不是乱猜', () => {
  a.ok(Number.isNaN(T.parseBeijing('')))
  a.ok(Number.isNaN(T.parseBeijing('明天八点')))
  a.ok(Number.isNaN(T.parseBeijing(null)))
  a.ok(Number.isNaN(T.parseBeijing(undefined)))
})

test('toBeijingInput 是 parseBeijing 的逆运算', () => {
  const v = '2026-09-12T20:00'
  a.strictEqual(T.toBeijingInput(T.parseBeijing(v)), v)
  a.strictEqual(T.toBeijingInput(Date.parse('2026-01-01T00:00:00+08:00')), '2026-01-01T00:00')
  a.strictEqual(T.toBeijingInput(NaN), '')
})

test('显示时主显北京时间', () => {
  const s = T.fmtSiteTime(Date.parse('2026-09-12T20:00:00+08:00'))
  a.ok(s.includes('北京时间'), s)
  a.ok(/2026.*9.*12.*20:00/.test(s), '必须出现北京时间的 20:00,实际 ' + s)
  if (T.localTz() !== 'Asia/Shanghai') a.ok(s.includes('本机'), '时区不同时要附本机时间: ' + s)
})

test('非法时间戳显示为占位符', () => {
  a.strictEqual(T.fmtSiteTime(NaN), '—')
  a.strictEqual(T.fmtSiteTime('不是时间'), '—')
})

test('倒计时拆分', () => {
  a.deepStrictEqual(T.countdownParts(3_661_234), { h: 1, m: 1, s: 1, ms: 234 })
  a.deepStrictEqual(T.countdownParts(-5), { h: 0, m: 0, s: 0, ms: 0 }, '过期按 0 处理')
})
