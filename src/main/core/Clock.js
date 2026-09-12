'use strict'
/**
 * Clock —— 服务器时钟校准 + 高精度定时。
 *
 * 抢购的成败先取决于"你以为的 10:00:00.000 是不是服务器的 10:00:00.000"。
 * 本机时钟和目标站服务器之间几百毫秒的偏差非常常见,必须校准。
 *
 * 难点:HTTP 的 Date 响应头**只有秒级精度**。直接 `serverDate - localNow` 最多只能精确到 ±1000ms。
 *
 * 解法(区间收敛):每个样本给出的不是一个点,而是一个约束区间。
 *   收到 Date: S(整秒)时,真实服务器时间 ∈ [S, S+1000)
 *   请求在本地 t0 发出、t1 收到,服务器生成该头的本地时刻 ∈ [t0, t1]
 *   => offset = 服务器时间 - 本地时间 ∈ [S - t1, S + 1000 - t0)
 * 多个样本的区间求交集,交集会随着样本跨越不同的"秒边界"而迅速收窄。
 * RTT 越小、样本在一秒内分布越均匀,收敛越紧,实测通常能到 ±(RTT/2) 量级。
 *
 * 这个模块不 require electron(取样用注入的 fetch),可以直接用 node 跑测试。
 */

const DEFAULT_SAMPLES = 12

/** 连续这么多条样本都和既有区间矛盾,才认为是时钟真的跳变了,而不是混进了一条杂样本 */
const CONFLICT_TOLERANCE = 3

class Clock {
  /**
   * @param {object} [opts]
   * @param {(url:string, init:object)=>Promise<{headers:{get(name:string):string|null}}>} [opts.fetchImpl]
   * @param {()=>number} [opts.nowImpl]  返回本地单调毫秒(默认用 hrtime 对齐到 Date.now 的高精度时钟)
   * @param {(level:string,msg:string,data?:object)=>void} [opts.log]
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    this.nowImpl = opts.nowImpl || makeHiResNow()
    this.log = opts.log || (() => {})

    /** offset 的可行区间(毫秒),offset = serverTime - localTime */
    this.lo = -Infinity
    this.hi = Infinity
    this.sampleCount = 0
    this.lastSyncAt = null
    this.source = null
    this._conflicts = 0
  }

  /** 当前最佳 offset 估计(区间中点)。没校准过就是 0。 */
  get offsetMs() {
    if (!Number.isFinite(this.lo) || !Number.isFinite(this.hi)) return 0
    return Math.round((this.lo + this.hi) / 2)
  }

  /** 当前估计的不确定度(±ms)。没校准过是 Infinity。 */
  get uncertaintyMs() {
    if (!Number.isFinite(this.lo) || !Number.isFinite(this.hi)) return Infinity
    return Math.round((this.hi - this.lo) / 2)
  }

  /** 校准后的"服务器现在时间"(毫秒) */
  now() {
    return this.nowImpl() + this.offsetMs
  }

  /** 服务器时间戳 -> 本地时间戳 */
  toLocal(serverTs) {
    return serverTs - this.offsetMs
  }

  /**
   * 喂一个观测样本进来。被动采集(webRequest.onHeadersReceived)和主动采样都走这里。
   * @param {string|number} dateHeader  响应头 Date 的原始值,或已解析的毫秒时间戳(必须是整秒)
   * @param {number} sentAt      本地发出请求的时刻
   * @param {number} receivedAt  本地收到响应的时刻
   * @returns {boolean} 该样本是否被采纳(与既有区间矛盾的样本会被丢弃)
   */
  observe(dateHeader, sentAt, receivedAt) {
    const serverSec = typeof dateHeader === 'number' ? dateHeader : Date.parse(dateHeader)
    if (!Number.isFinite(serverSec)) return false
    if (!(receivedAt >= sentAt)) return false

    const lo = serverSec - receivedAt
    const hi = serverSec + 1000 - sentAt

    const nextLo = Math.max(this.lo, lo)
    const nextHi = Math.min(this.hi, hi)

    if (nextLo >= nextHi) {
      // 矛盾的来源有两种,处理方式完全不同:
      //   偶发一两条 —— 多半是某个走了别的服务器/缓存的响应混了进来,应该**丢掉它**,而不是推翻已有估计;
      //   连续好几条 —— 说明本机时钟真的被改了(或换了目标站),这时才该重开区间。
      // 早期无条件重置,导致一条杂样本就能毁掉已经收敛好的结果。
      this._conflicts = (this._conflicts || 0) + 1
      if (this._conflicts < CONFLICT_TOLERANCE) {
        this.log('debug', 'clock: 丢弃一条矛盾样本', { conflicts: this._conflicts, sample: [lo, hi] })
        return false
      }
      this.log('warn', 'clock: 连续矛盾,判定时钟已跳变,重开区间', {
        prev: [this.lo, this.hi], sample: [lo, hi], conflicts: this._conflicts,
      })
      this.lo = lo
      this.hi = hi
      this.sampleCount = 1
      this._conflicts = 0
      return true
    }

    this._conflicts = 0
    this.lo = nextLo
    this.hi = nextHi
    this.sampleCount += 1
    return true
  }


  /**
   * 规划下一次取样应该等多久。
   *
   * 区间宽度的理论下界就是 RTT —— 前提是样本要**骑在服务器的整秒边界上**:
   * 边界前一刻的样本把 hi 压下来,边界后一刻的样本把 lo 顶上去。
   * 随机相位取样要靠运气才碰得到边界,所以这里主动瞄准边界:
   * 先用当前估计推算出"下一个服务器整秒"对应的本地时刻,然后交替取样在它的前后。
   *
   * @param {number} nowLocal 当前本地时刻
   * @param {number} i        第几次取样(用来在边界前/后交替)
   * @returns {number} 建议等待的毫秒数
   */
  planNextSampleDelay(nowLocal, i) {
    // 还没有任何估计时,用错开的固定相位先把区间粗收一遍
    if (!Number.isFinite(this.lo) || !Number.isFinite(this.hi)) {
      return 60 + (i % 7) * 43
    }
    const offset = this.offsetMs
    const serverNow = nowLocal + offset
    const nextBoundaryServer = Math.ceil((serverNow + 1) / 1000) * 1000
    const boundaryLocal = nextBoundaryServer - offset
    // 交替瞄准边界前 ~8ms 与边界后 ~8ms(RTT 会把样本本身抹开,不必贴太死)
    const aim = (i % 2 === 0) ? boundaryLocal - 8 : boundaryLocal + 8
    let delay = aim - nowLocal
    while (delay < 5) delay += 1000     // 已经错过这个边界就瞄下一个
    return delay
  }

  /** 丢弃所有样本,回到未校准状态 */
  reset() {
    this.lo = -Infinity
    this.hi = Infinity
    this.sampleCount = 0
    this.lastSyncAt = null
    this.source = null
    this._conflicts = 0
  }

  /**
   * 主动对某个 URL 连续采样校准。
   * 用 HEAD + cache: 'no-store',并带一个变化的查询串,避免中间缓存把旧的 Date 头喂回来。
   */
  async syncWith(url, { samples = DEFAULT_SAMPLES, minIntervalMs = 60, requestTimeoutMs = 4000, totalTimeoutMs = 30000 } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new Error('Clock: 没有可用的 fetch 实现')
    let ok = 0
    const deadline = this.nowImpl() + totalTimeoutMs
    // 有些 CDN 对 HEAD 不响应,第一枪打不中就整轮换成 GET
    let method = 'HEAD'
    let methodFallbackTried = false

    for (let i = 0; i < samples; i++) {
      if (this.nowImpl() > deadline) {
        this.log('warn', 'clock: 校准总超时,用已有样本收工', { url, samples: ok })
        break
      }
      const bust = `${url}${url.includes('?') ? '&' : '?'}_t=${i}_${Math.floor(this.nowImpl())}`
      const sentAt = this.nowImpl()
      let res
      try {
        // 必须带超时:对端不回包时 fetch 会一直挂着,整个校准(以及调用它的 UI)就卡死了
        res = await this.fetchImpl(bust, {
          method, cache: 'no-store', redirect: 'follow',
          signal: AbortSignal.timeout(requestTimeoutMs),
        })
      } catch (err) {
        this.log('warn', 'clock: 采样失败', { url, method, err: String(err && err.message || err) })
        if (method === 'HEAD' && !methodFallbackTried) { methodFallbackTried = true; method = 'GET'; i-- }
        continue
      }
      const receivedAt = this.nowImpl()
      const dateHeader = res && res.headers && res.headers.get ? res.headers.get('date') : null
      // 命中缓存的响应 Date 是旧的,会毒化校准
      const age = res && res.headers && res.headers.get ? res.headers.get('age') : null
      if (!dateHeader || (age && Number(age) > 0)) {
        if (!dateHeader && method === 'HEAD' && !methodFallbackTried) { methodFallbackTried = true; method = 'GET' }
        continue
      }
      // GET 兜底时要把响应体读完,否则连接挂着不放
      if (method === 'GET' && res.body && typeof res.body.cancel === 'function') { try { res.body.cancel() } catch (e) { /* ignore */ } }
      // RTT 过大的样本区间太宽,收不紧还拖时间,直接丢
      if (receivedAt - sentAt > 2000) continue
      if (this.observe(dateHeader, sentAt, receivedAt)) ok++
      // 自适应相位:一旦有了粗估计,就把后续样本瞄到服务器整秒边界的两侧
      if (i < samples - 1) {
        const wait = Math.max(minIntervalMs, this.planNextSampleDelay(this.nowImpl(), i))
        await sleep(Math.min(wait, 1200))
      }
    }
    if (ok > 0) {
      this.lastSyncAt = Date.now()
      this.source = url
      this.log('info', 'clock: 校准完成', {
        url, samples: ok, offsetMs: this.offsetMs, uncertaintyMs: this.uncertaintyMs,
      })
    }
    return { samples: ok, offsetMs: this.offsetMs, uncertaintyMs: this.uncertaintyMs }
  }

  /**
   * 在"服务器时间"的某个时刻执行 fn,精度做到毫秒级。
   *
   * 三段式:
   *   1. 粗睡:setTimeout 到 T-120ms(setTimeout 在高负载下漂移可达数十毫秒,所以不能一睡到底)
   *   2. 细轮询:setTimeout(0) 逐次逼近到 T-spinMs
   *   3. 自旋:hrtime 忙等最后几毫秒 —— 只阻塞几毫秒,换来确定性
   *
   * @param {number} serverTs   目标的服务器时间戳(毫秒)
   * @param {Function} fn
   * @param {object} [opts]
   * @param {number} [opts.spinMs=6]   自旋时长上限
   * @param {number} [opts.leadMs=0]   提前量:网络到服务器还要时间,通常给 20~80ms
   * @returns {{cancel:()=>void, targetLocalTs:number}}
   */
  scheduleAt(serverTs, fn, opts = {}) {
    const spinMs = opts.spinMs == null ? 6 : opts.spinMs
    const leadMs = opts.leadMs || 0
    const targetLocalTs = this.toLocal(serverTs) - leadMs

    let cancelled = false
    let timer = null

    const step = () => {
      if (cancelled) return
      const remain = targetLocalTs - this.nowImpl()
      if (remain > 120) {
        timer = setTimeout(step, remain - 100)
      } else if (remain > spinMs) {
        timer = setTimeout(step, 0)
      } else {
        // 自旋到点
        while (!cancelled && this.nowImpl() < targetLocalTs) { /* busy wait */ }
        if (cancelled) return
        try { fn() } catch (err) { this.log('error', 'clock: 定时任务抛错', { err: String(err) }) }
      }
    }

    step()
    return {
      targetLocalTs,
      cancel() { cancelled = true; if (timer) clearTimeout(timer) },
    }
  }

  /** 给 UI 用的快照 */
  snapshot() {
    return {
      offsetMs: this.offsetMs,
      uncertaintyMs: Number.isFinite(this.uncertaintyMs) ? this.uncertaintyMs : null,
      samples: this.sampleCount,
      lastSyncAt: this.lastSyncAt,
      source: this.source,
      synced: this.sampleCount > 0,
    }
  }
}

/** 高精度本地时钟:用 hrtime 走时,避免 Date.now() 的粗粒度与系统校时跳变 */
function makeHiResNow() {
  const baseWall = Date.now()
  const baseHr = process.hrtime.bigint()
  return function hiResNow() {
    return baseWall + Number(process.hrtime.bigint() - baseHr) / 1e6
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

module.exports = { Clock, makeHiResNow }
