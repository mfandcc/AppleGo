'use strict'
/**
 * GuestRpc —— 主进程 -> 被控页面 preload 的请求/响应通道。
 *
 * 为什么不用 webContents.executeJavaScript:
 * 那段代码跑在页面的**主世界**里,目标站点的 JS 能覆盖我们注入的函数,也能观察到我们在做什么。
 * preload 的隔离世界页面碰不到,所以定位逻辑放在那边,主进程用这条 RPC 去调它。
 *
 * 实测(#11):一次往返约 0.1~0.3ms,N=50 并发也只有几毫秒 —— 完全够抢购用。
 */

const { ipcMain } = require('electron')

const CH_RPC = 'applego:guest:rpc'
const CH_RESULT = 'applego:guest:rpc-result'

class GuestRpc {
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs == null ? 5000 : opts.timeoutMs
    this.logger = opts.logger || { warn() {}, debug() {} }
    this.pending = new Map()
    this.seq = 0
    ipcMain.on(CH_RESULT, (_e, msg) => {
      if (!msg) return
      const entry = this.pending.get(msg.id)
      if (!entry) return                 // 超时后迟到的回包,丢掉
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      entry.resolve(msg.result)
    })
  }

  /**
   * @param {Electron.WebContents} wc
   * @param {string} method  guest preload 里 rpcMethods 的方法名
   * @param {object} [params]
   * @param {object} [opts] { timeoutMs }
   * @returns {Promise<object>} 永远 resolve,失败也是 {ok:false,reason}。
   *   调用方全是同步链路上的热路径,不想到处套 try/catch。
   */
  call(wc, method, params, opts = {}) {
    if (!wc || wc.isDestroyed()) return Promise.resolve({ ok: false, reason: 'destroyed' })
    const id = ++this.seq
    const timeoutMs = opts.timeoutMs == null ? this.timeoutMs : opts.timeoutMs
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, reason: 'timeout', method, timeoutMs })
      }, timeoutMs)
      if (timer.unref) timer.unref()
      this.pending.set(id, { resolve, timer })
      try {
        wc.send(CH_RPC, { id, method, params: params || {} })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, reason: 'send-failed', error: String(err) })
      }
    })
  }

  /** 对一组 webContents 并发调用同一个方法 */
  callAll(list, method, params, opts) {
    return Promise.all(list.map(wc => this.call(wc, method, params, opts)))
  }

  /** webContents 销毁时清掉它的挂起请求(其实超时也会清,这里是提前释放) */
  dispose() {
    for (const [, entry] of this.pending) clearTimeout(entry.timer)
    this.pending.clear()
    ipcMain.removeAllListeners(CH_RESULT)
  }
}

module.exports = { GuestRpc, CH_RPC, CH_RESULT }
