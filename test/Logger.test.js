'use strict'
const { test } = require('node:test')
const a = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Logger } = require('../src/main/core/Logger.js')

test('按等级过滤', () => {
  const l = new Logger({ level: 'warn' })
  l.info('看不见'); l.warn('看得见'); l.error('也看得见')
  a.strictEqual(l.buffer.length, 2)
})

test('环形缓冲不会无限涨', () => {
  const l = new Logger({ bufferSize: 10, level: 'debug' })
  for (let i = 0; i < 100; i++) l.info('m' + i)
  a.strictEqual(l.buffer.length, 10)
  a.strictEqual(l.buffer[9].msg, 'm99', '保留的应该是最新的')
  a.strictEqual(l.buffer[0].msg, 'm90')
})

test('forInstance 自动带上 instanceId', () => {
  const l = new Logger()
  l.forInstance('inst-3').info('加载完成')
  a.strictEqual(l.buffer[0].data.instanceId, 'inst-3')
})

test('recent 支持按实例与等级过滤', () => {
  const l = new Logger({ level: 'debug' })
  l.forInstance('a').info('x'); l.forInstance('b').error('y'); l.forInstance('a').warn('z')
  a.strictEqual(l.recent(100, { instanceId: 'a' }).length, 2)
  a.strictEqual(l.recent(100, { level: 'warn' }).length, 2)
  a.strictEqual(l.recent(100, { instanceId: 'a', level: 'warn' }).length, 1)
})

test('超长字段被截断,不让一次异常写爆磁盘', () => {
  const l = new Logger()
  l.info('x', { html: 'A'.repeat(50000) })
  a.ok(l.buffer[0].data.html.length < 2100)
})

test('Error 对象记的是 message 而不是整个对象', () => {
  const l = new Logger()
  l.error('崩了', { err: new Error('boom') })
  a.strictEqual(l.buffer[0].data.err, 'boom')
})

test('onEntry 回调抛错不会打穿日志本身', () => {
  const l = new Logger({ onEntry: () => { throw new Error('bad subscriber') } })
  a.doesNotThrow(() => l.info('still works'))
  a.strictEqual(l.buffer.length, 1)
})

test('落盘为逐行 JSON,且 close() 会等真正写完', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applego-log-'))
  const l = new Logger({ dir, level: 'debug' })
  l.info('第一条', { instanceId: 'i1' })
  await l.close()
  const file = fs.readdirSync(dir).find(f => f.endsWith('.log'))
  a.ok(file, '应该生成日志文件')
  const line = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n')[0])
  a.strictEqual(line.msg, '第一条')
  a.strictEqual(line.data.instanceId, 'i1')
})

test('seq 单调递增,便于前端增量拉取', () => {
  const l = new Logger()
  l.info('a'); l.info('b'); l.info('c')
  a.deepStrictEqual(l.buffer.map(e => e.seq), [1, 2, 3])
})
