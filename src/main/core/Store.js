'use strict'
/**
 * Store —— 配置持久化。
 *
 * 抢购配置(实例、profile、任务、剧本)丢了很难受,所以写盘走"临时文件 + rename"的原子替换,
 * 断电/崩溃最多丢掉最后一次未落盘的改动,不会留下半截 JSON 把整个配置读废。
 * 另外保留一份 .bak,解析失败时自动回退。
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

class Store {
  /**
   * @param {string} filePath
   * @param {object} defaults 读不到文件时的初始值
   * @param {object} [opts] { log, debounceMs }
   */
  constructor(filePath, defaults = {}, opts = {}) {
    this.filePath = filePath
    this.bakPath = filePath + '.bak'
    this.tmpPath = filePath + '.tmp'
    this.defaults = defaults
    this.log = opts.log || (() => {})
    this.debounceMs = opts.debounceMs == null ? 250 : opts.debounceMs
    this.data = null
    this._timer = null
    this._writing = null
    this._pending = false
  }

  /** 同步读取(启动路径上用,省得到处 await) */
  loadSync() {
    this.data = this._readSync(this.filePath) || this._readSync(this.bakPath) || deepClone(this.defaults)
    // 顶层缺字段时补上默认值,方便后续版本加字段
    for (const k of Object.keys(this.defaults)) {
      if (this.data[k] === undefined) this.data[k] = deepClone(this.defaults[k])
    }
    return this.data
  }

  _readSync(p) {
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
      return null
    } catch (err) {
      if (err.code !== 'ENOENT') this.log('warn', 'store: 读取失败', { path: p, err: String(err) })
      return null
    }
  }

  get(key, fallback) {
    if (!this.data) this.loadSync()
    const v = this.data[key]
    return v === undefined ? fallback : v
  }

  set(key, value) {
    if (!this.data) this.loadSync()
    this.data[key] = value
    this.scheduleSave()
    return value
  }

  /** 批量改,只触发一次写盘 */
  update(patch) {
    if (!this.data) this.loadSync()
    Object.assign(this.data, patch)
    this.scheduleSave()
    return this.data
  }

  /** 合并写盘请求,避免拖动滑块时每帧写一次盘 */
  scheduleSave() {
    if (this._timer) return
    this._timer = setTimeout(() => { this._timer = null; this.save() }, this.debounceMs)
    if (this._timer.unref) this._timer.unref()
  }

  /**
   * 原子写盘。并发调用会被串行化:正在写就标记 pending,写完再补一次,
   * 保证最终落盘的一定是最新数据,且永远只有一个写操作在跑。
   */
  async save() {
    if (this._writing) { this._pending = true; return this._writing }
    this._writing = this._doSave().finally(() => {
      this._writing = null
      if (this._pending) { this._pending = false; this.save() }
    })
    return this._writing
  }

  async _doSave() {
    if (!this.data) return
    const json = JSON.stringify(this.data, null, 2)
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true })
      // 先备份当前这份好的,再原子替换
      try { await fsp.copyFile(this.filePath, this.bakPath) } catch (e) { if (e.code !== 'ENOENT') throw e }
      await fsp.writeFile(this.tmpPath, json, 'utf8')
      await fsp.rename(this.tmpPath, this.filePath)      // rename 在同一文件系统上是原子的
    } catch (err) {
      this.log('error', 'store: 写盘失败', { path: this.filePath, err: String(err) })
      throw err
    }
  }

  /** 退出前调用:取消 debounce,立刻落盘 */
  async flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    await this.save()
  }
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

module.exports = { Store }
