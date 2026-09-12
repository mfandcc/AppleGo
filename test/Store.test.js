'use strict'
const { test } = require('node:test')
const a = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Store } = require('../src/main/core/Store.js')

function tmpFile(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'applego-store-'))
  return path.join(d, name || 'config.json')
}

test('读不到文件时用默认值,并补齐新增的顶层字段', () => {
  const p = tmpFile()
  const s = new Store(p, { instances: [], version: 1 })
  s.loadSync()
  a.deepStrictEqual(s.get('instances'), [])
  a.strictEqual(s.get('version'), 1)
  a.strictEqual(s.get('missing', 'fallback'), 'fallback')
})

test('默认值是深拷贝,改了实例数据不会污染下一个 Store', () => {
  const defaults = { list: [{ n: 1 }] }
  const s1 = new Store(tmpFile(), defaults); s1.loadSync()
  s1.get('list').push({ n: 2 })
  const s2 = new Store(tmpFile(), defaults); s2.loadSync()
  a.strictEqual(s2.get('list').length, 1, '默认值被污染了')
})

test('原子写盘后能读回来', async () => {
  const p = tmpFile()
  const s = new Store(p, { a: 1 }, { debounceMs: 0 })
  s.loadSync(); s.set('a', 42); s.set('b', 'hi')
  await s.flush()
  a.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 42, b: 'hi' })
  a.ok(!fs.existsSync(p + '.tmp'), '临时文件必须被 rename 掉')
})

test('JSON 损坏时自动回退到 .bak', async () => {
  const p = tmpFile()
  const s = new Store(p, { v: 0 }, { debounceMs: 0 })
  s.loadSync(); s.set('v', 1); await s.flush()
  s.set('v', 2); await s.flush()                 // 这次会把 v:1 备份进 .bak
  fs.writeFileSync(p, '{ 这不是合法 JSON')
  const s2 = new Store(p, { v: 0 }); s2.loadSync()
  a.strictEqual(s2.get('v'), 1, '应该从 .bak 回退')
})

test('主文件和备份都坏掉时退回默认值,不抛异常', () => {
  const p = tmpFile()
  fs.writeFileSync(p, 'garbage')
  fs.writeFileSync(p + '.bak', 'also garbage')
  const s = new Store(p, { safe: true }); s.loadSync()
  a.strictEqual(s.get('safe'), true)
})

test('并发 save 会串行化,最后落盘的是最新数据', async () => {
  const p = tmpFile()
  const s = new Store(p, {}, { debounceMs: 0 })
  s.loadSync()
  const writes = []
  for (let i = 0; i < 20; i++) { s.set('n', i); writes.push(s.save()) }
  await Promise.all(writes)
  await s.flush()
  a.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).n, 19)
})

test('debounce 合并多次写', async () => {
  const p = tmpFile()
  const s = new Store(p, {}, { debounceMs: 30 })
  s.loadSync()
  for (let i = 0; i < 100; i++) s.set('n', i)
  a.ok(!fs.existsSync(p), 'debounce 期间不应该已经写盘')
  await s.flush()
  a.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).n, 99)
})

test('update 批量改只写一次', async () => {
  const p = tmpFile()
  const s = new Store(p, { a: 0, b: 0 }, { debounceMs: 0 })
  s.loadSync(); s.update({ a: 1, b: 2 }); await s.flush()
  a.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1, b: 2 })
})
