'use strict'
/**
 * TaskScheduler —— 定时抢购。
 *
 * 一个任务的时间线(t 为校准后的服务器时间):
 *   t - primeLeadMs   预热:让每个实例先把目标元素在 DOM 里定位好并缓存(约 0.1~0.3ms/实例,并发)
 *   t - 1500ms        复检:再预热一次,吃掉这段时间里页面的懒加载/重排
 *   t - leadMs        开火:只剩一次 sendInputEvent(实测约 9μs),不再回 DOM
 *
 * leadMs 是"网络提前量":你的点击要走到服务器还需要时间,填单程 RTT 量级(通常 20~80ms)。
 * 关键路径被压到只剩注入本身,是这个设计的全部意义。
 */

const { randomUUID } = require('crypto')

const STATES = ['idle', 'armed', 'priming', 'ready', 'firing', 'done', 'failed', 'cancelled']

class TaskScheduler {
  /**
   * @param {object} deps { clock, sync, instances, logger, onChange }
   */
  constructor(deps) {
    this.clock = deps.clock
    this.sync = deps.sync
    this.instances = deps.instances
    this.logger = deps.logger
    this.onChange = deps.onChange || (() => {})

    this.tasks = new Map()
    this.timers = new Map()    // taskId -> [cancelFn]
  }

  list() { return Array.from(this.tasks.values()).map(t => this._pub(t)) }

  save(input) {
    const id = input.id || randomUUID().slice(0, 8)
    const prev = this.tasks.get(id)
    const task = {
      id,
      name: input.name || '未命名任务',
      url: input.url || null,
      atServerTs: input.atServerTs,
      selector: input.selector || null,
      descriptor: input.descriptor || (input.selector ? descriptorFromSelector(input.selector) : null),
      primeLeadMs: input.primeLeadMs == null ? 5000 : input.primeLeadMs,
      leadMs: input.leadMs || 0,
      targets: input.targets || 'all',
      state: prev ? prev.state : 'idle',
      result: prev ? prev.result : null,
      createdAt: prev ? prev.createdAt : Date.now(),
    }
    this.tasks.set(id, task)
    this._emit(task)
    return this._pub(task)
  }

  delete(id) {
    this.cancel(id)
    const ok = this.tasks.delete(id)
    this._emitNext()
    return ok
  }

  /** 布防:把预热和开火都排进时间线 */
  arm(id) {
    const task = this.tasks.get(id)
    if (!task) return { ok: false, reason: 'not-found' }
    if (!task.atServerTs) return { ok: false, reason: 'no-time' }
    this.cancel(id, { silent: true })

    const cancels = []
    const now = this.clock.now()
    const remain = task.atServerTs - now
    if (remain <= 0) return { ok: false, reason: 'already-past' }

    if (!this.clock.snapshot().synced) {
      this.logger.warn('时钟未校准就布防,开抢时刻可能偏差 ±500ms 以上', { taskId: id })
    }

    // 提前打开页面(如果任务指定了 url)
    if (task.url && remain > task.primeLeadMs + 2000) {
      cancels.push(this.clock.scheduleAt(task.atServerTs - task.primeLeadMs - 2000, () => {
        this.instances.navigate(task.targets, task.url, this.sync.masterId)
      }).cancel)
    }

    // 预热
    cancels.push(this.clock.scheduleAt(task.atServerTs - task.primeLeadMs, () => {
      this._setState(task, 'priming')
      this.sync.prime(task.id, task.descriptor, this._targets(task))
        .then(res => {
          const ok = res.filter(r => r.ok).length
          this._setState(task, ok ? 'ready' : 'failed')
          if (!ok) this.logger.error('预热全部失败,该任务到点大概率点不中', { taskId: id })
        })
    }).cancel)

    // 临门复检:吃掉预热之后页面的重排/懒加载
    if (task.primeLeadMs > 2500) {
      cancels.push(this.clock.scheduleAt(task.atServerTs - 1500, () => {
        this.sync.prime(task.id, task.descriptor, this._targets(task))
      }).cancel)
    }

    // 开火
    const fire = this.clock.scheduleAt(task.atServerTs, async () => {
      this._setState(task, 'firing')
      const rec = await this.sync.fire(task.id, this._targets(task), { verify: true })
      task.result = { ok: rec.ok, total: rec.total, latencyMs: rec.latencyMs, at: Date.now() }
      this._setState(task, rec.ok ? 'done' : 'failed')
      this.logger.info('抢购任务执行完毕', { taskId: id, ok: rec.ok, total: rec.total })
    }, { leadMs: task.leadMs, spinMs: 6 })
    cancels.push(fire.cancel)

    this.timers.set(id, cancels)
    this._setState(task, 'armed')
    this.logger.info('任务已布防', {
      taskId: id, name: task.name,
      距开抢: Math.round(remain / 1000) + 's',
      预热提前: task.primeLeadMs + 'ms', 提前量: task.leadMs + 'ms',
    })
    return { ok: true, targetLocalTs: fire.targetLocalTs }
  }

  cancel(id, { silent = false } = {}) {
    const cancels = this.timers.get(id)
    if (cancels) { for (const c of cancels) { try { c() } catch (e) { /* ignore */ } } }
    this.timers.delete(id)
    const task = this.tasks.get(id)
    if (task && !silent && ['armed', 'priming', 'ready'].includes(task.state)) this._setState(task, 'cancelled')
    return { ok: true }
  }

  /** 立刻执行一次(调试用:先预热再开火) */
  async runNow(id) {
    const task = this.tasks.get(id)
    if (!task) return { ok: false, reason: 'not-found' }
    this._setState(task, 'priming')
    await this.sync.prime(task.id, task.descriptor, this._targets(task))
    this._setState(task, 'firing')
    const rec = await this.sync.fire(task.id, this._targets(task), { verify: true })
    task.result = { ok: rec.ok, total: rec.total, latencyMs: rec.latencyMs, at: Date.now() }
    this._setState(task, rec.ok ? 'done' : 'failed')
    return { ok: true, record: rec }
  }

  _targets(task) {
    return this.instances.resolveTargets(task.targets, this.sync.masterId)
      .filter(i => i.webContents)
  }

  /** 给中控台看板用:最近一个待执行的任务 */
  next() {
    const now = this.clock.now()
    const upcoming = Array.from(this.tasks.values())
      .filter(t => t.atServerTs > now && ['armed', 'priming', 'ready'].includes(t.state))
      .sort((a, b) => a.atServerTs - b.atServerTs)
    if (!upcoming.length) return null
    const t = upcoming[0]
    return { ...this._pub(t), targetCount: this._targets(t).length }
  }

  _setState(task, state) {
    if (!STATES.includes(state)) throw new Error('未知任务状态: ' + state)
    task.state = state
    this._emit(task)
  }

  _emit(task) { this.onChange(this._pub(task)); this._emitNext() }
  _emitNext() { this.onChange(null, this.next()) }

  _pub(t) {
    return {
      id: t.id, name: t.name, url: t.url, atServerTs: t.atServerTs, selector: t.selector,
      primeLeadMs: t.primeLeadMs, leadMs: t.leadMs, targets: t.targets,
      state: t.state, result: t.result, createdAt: t.createdAt,
    }
  }

  disposeAll() { for (const id of this.timers.keys()) this.cancel(id, { silent: true }) }
}

/** 只给了 CSS 选择器时,凑一个最小 descriptor 让 Locator 能用 path 策略 */
function descriptorFromSelector(selector) {
  const idMatch = /^#([\w-]+)$/.exec(selector.trim())
  return {
    tag: '*',
    id: idMatch ? idMatch[1] : null,
    path: selector,
    offset: { x: 0.5, y: 0.5 },
    size: null,
  }
}

module.exports = { TaskScheduler, STATES, descriptorFromSelector }
