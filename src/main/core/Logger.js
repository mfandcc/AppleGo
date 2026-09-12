'use strict'
/**
 * Logger —— 结构化日志 + 内存环形缓冲。
 *
 * 抢购是一次性的:事后复盘时"当时第 7 个实例到底发生了什么"必须查得到。
 * 所以每条日志都带 instanceId / 事件类型,中控 UI 直接订阅这个缓冲区渲染事件流。
 * 落盘按天切分,单条日志超长会被截断,避免一次异常把磁盘写满。
 */

const fs = require('fs')
const path = require('path')

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_FIELD_LEN = 2000

class Logger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]        落盘目录,不给就只留内存
   * @param {string} [opts.level=info]
   * @param {number} [opts.bufferSize=2000]
   * @param {(entry:object)=>void} [opts.onEntry] 每条日志的回调(中控 UI 用它做实时事件流)
   */
  constructor(opts = {}) {
    this.dir = opts.dir || null
    this.level = LEVELS[opts.level] || LEVELS.info
    this.bufferSize = opts.bufferSize || 2000
    this.onEntry = opts.onEntry || null
    this.buffer = []
    this.seq = 0
    this._stream = null
    this._streamDay = null
    if (this.dir) { try { fs.mkdirSync(this.dir, { recursive: true }) } catch (e) { this.dir = null } }
  }

  log(level, msg, data) {
    if ((LEVELS[level] || 0) < this.level) return null
    const entry = {
      seq: ++this.seq,
      ts: Date.now(),
      level,
      msg: String(msg).slice(0, MAX_FIELD_LEN),
      ...(data ? { data: truncate(data) } : {}),
    }

    this.buffer.push(entry)
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize)

    if (this.onEntry) { try { this.onEntry(entry) } catch (e) { /* 日志回调抛错不能反过来打穿日志 */ } }
    this._write(entry)

    const tag = level === 'error' ? '✖' : level === 'warn' ? '!' : '·'
    const scope = entry.data && entry.data.instanceId ? `[#${entry.data.instanceId}] ` : ''
    console.log(`${tag} ${scope}${entry.msg}`)
    return entry
  }

  debug(msg, data) { return this.log('debug', msg, data) }
  info(msg, data) { return this.log('info', msg, data) }
  warn(msg, data) { return this.log('warn', msg, data) }
  error(msg, data) { return this.log('error', msg, data) }

  /** 绑定实例上下文,省得每条都手写 instanceId */
  forInstance(instanceId) {
    const self = this
    const wrap = level => (msg, data) => self.log(level, msg, { instanceId, ...(data || {}) })
    return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') }
  }

  /** 取最近 N 条(中控 UI 首次加载用) */
  recent(n = 200, filter) {
    let out = this.buffer
    if (filter) {
      if (filter.level) { const min = LEVELS[filter.level] || 0; out = out.filter(e => LEVELS[e.level] >= min) }
      if (filter.instanceId != null) out = out.filter(e => e.data && e.data.instanceId === filter.instanceId)
    }
    return out.slice(-n)
  }

  clear() { this.buffer = [] }

  _write(entry) {
    if (!this.dir) return
    const day = new Date(entry.ts).toISOString().slice(0, 10)
    if (day !== this._streamDay) {
      if (this._stream) this._stream.end()
      try {
        this._stream = fs.createWriteStream(path.join(this.dir, `applego-${day}.log`), { flags: 'a' })
        this._stream.on('error', () => { this._stream = null })   // 磁盘满/权限问题不能拖垮主进程
        this._streamDay = day
      } catch (e) { this._stream = null; this.dir = null; return }
    }
    if (this._stream) { try { this._stream.write(JSON.stringify(entry) + '\n') } catch (e) { /* ignore */ } }
  }

  /**
   * 关闭日志流并等它真正写完。
   * createWriteStream 的 open/write 都是异步的,退出前不 await 会丢掉最后几条 ——
   * 而抢购失败时最后几条恰恰是最该看的。
   */
  close() {
    const stream = this._stream
    this._stream = null
    this._streamDay = null
    if (!stream) return Promise.resolve()
    return new Promise(resolve => {
      stream.end(() => resolve())
      stream.on('error', () => resolve())
    })
  }
}

function truncate(data) {
  const out = {}
  for (const k of Object.keys(data)) {
    const v = data[k]
    if (typeof v === 'string' && v.length > MAX_FIELD_LEN) out[k] = v.slice(0, MAX_FIELD_LEN) + '…'
    else if (v instanceof Error) out[k] = v.message
    else out[k] = v
  }
  return out
}

module.exports = { Logger, LEVELS }
