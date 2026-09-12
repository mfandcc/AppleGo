'use strict'
/**
 * IPC 路由 —— 把 shared/ipc.js 里声明的通道接到各个模块上。
 *
 * 所有 handler 统一兜错:中控台调用永远拿到 {ok:false, error} 而不是一个 rejected promise,
 * 省得 UI 到处 try/catch,也避免主进程里出现未捕获的 rejection。
 */

const { ipcMain } = require('electron')
const { INVOKE, GUEST } = require('../../shared/ipc.js')

function register(ctx) {
  const { instances, sync, clock, tasks, logger, sessionFactory, store, push } = ctx

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_e, payload) => {
      try {
        return await fn(payload || {})
      } catch (err) {
        logger.error('IPC 处理失败', { channel, err: String(err && err.stack || err) })
        return { ok: false, error: String(err && err.message || err) }
      }
    })
  }

  /* ---------------------------------------------------------- 状态 */

  const fullState = () => ({
    instances: instances.snapshot(),
    sync: {
      enabled: sync.enabled, mode: sync.mode, masterId: sync.masterId,
      allowTextKeys: sync.allowTextKeys, hover: ctx.captureOpts.hover,
    },
    clock: clock.snapshot(),
    tasks: tasks.list(),
    nextTask: tasks.next(),
    layout: ctx.layout,
  })
  ctx.fullState = fullState

  handle(INVOKE.stateGet, () => fullState())

  /* ---------------------------------------------------------- 实例 */

  handle(INVOKE.instanceCreate, async p => {
    const created = await instances.create(p)
    // 第一个实例自动成为主机,否则新用户开了同步却发现没反应
    if (sync.masterId == null && created.length) ctx.setMaster(created[0].id)
    else instances.applyRoles(sync.masterId, ctx.captureOpts)
    push.state(fullState())
    return created.map(i => i.snapshot())
  })

  handle(INVOKE.instanceRemove, p => {
    const wasMaster = p.id === sync.masterId
    const ok = instances.remove(p.id)
    if (wasMaster) {
      const next = instances.list()[0]
      ctx.setMaster(next ? next.id : null)
    }
    push.state(fullState())
    return { ok }
  })

  handle(INVOKE.instanceUpdate, p => {
    const inst = instances.get(p.id)
    if (!inst) return { ok: false, reason: 'not-found' }
    Object.assign(inst, pick(p.patch, ['name', 'enabled']))
    inst._emit()
    return inst.snapshot()
  })

  handle(INVOKE.instanceNavigate, p => ({ ok: true, count: instances.navigate(p.id, p.url, sync.masterId) }))
  handle(INVOKE.instanceReload, p => ({ ok: true, count: instances.reload(p.id, sync.masterId) }))

  handle(INVOKE.instanceSetMaster, p => { ctx.setMaster(p.id); push.state(fullState()); return { ok: true } })

  handle(INVOKE.instanceFocus, p => { instances.setFocused(p.id); return { ok: true } })

  handle(INVOKE.instanceReset, async p => {
    const inst = instances.get(p.id)
    if (!inst) return { ok: false, reason: 'not-found' }
    await sessionFactory.reset(inst.profile.id, { keepCookies: p.keepCookies })
    inst.reload()
    return { ok: true }
  })

  handle(INVOKE.instanceCloneCookies, async p => {
    const from = instances.get(p.from)
    if (!from) return { ok: false, reason: 'source-not-found' }
    const targets = (p.to && p.to.length ? p.to : instances.list().map(i => i.id))
      .filter(id => id !== p.from)
    const res = []
    for (const id of targets) {
      const inst = instances.get(id)
      if (inst) res.push(await sessionFactory.cloneCookies(from.profile.id, inst.profile.id))
    }
    return { ok: true, results: res }
  })

  handle(INVOKE.instanceDevtools, p => {
    const inst = instances.get(p.id)
    return { ok: inst ? inst.openDevTools() : false }
  })

  /* ---------------------------------------------------------- 标签页 */

  handle(INVOKE.tabCreate, p => {
    const inst = instances.get(p.instanceId)
    if (!inst) return { ok: false, reason: 'not-found' }
    const tab = inst.createTab(p.url)
    return { ok: true, tab: { id: tab.id, url: tab.url } }
  })

  handle(INVOKE.tabClose, p => {
    const inst = instances.get(p.instanceId)
    return { ok: inst ? inst.closeTab(p.tabId) : false }
  })

  handle(INVOKE.tabActivate, p => {
    const inst = instances.get(p.instanceId)
    return { ok: inst ? inst.activate(p.tabId) : false }
  })

  /* ---------------------------------------------------------- 同步 */

  handle(INVOKE.syncSet, p => {
    if (p.mode != null) sync.setMode(p.mode)
    if (p.allowTextKeys != null) sync.allowTextKeys = !!p.allowTextKeys
    if (p.hover != null) { ctx.captureOpts.hover = !!p.hover; instances.applyRoles(sync.masterId, ctx.captureOpts) }
    if (p.enabled != null) {
      if (p.enabled && sync.masterId == null) {
        const first = instances.list()[0]
        if (first) ctx.setMaster(first.id)
      }
      sync.setEnabled(p.enabled)
    }
    const s = fullState()
    push.state(s)
    return s.sync
  })

  handle(INVOKE.syncPrime, p => sync.prime(p.key, p.descriptor))
  handle(INVOKE.syncArm, p => {
    const targets = p.targets ? instances.resolveTargets(p.targets, sync.masterId).filter(i => i.webContents) : null
    return sync.armPounce(p.key, p.descriptor, targets && targets.map(i => ({
      id: i.id, webContents: i.webContents, boundsW: i.bounds.w,
      zoomFactor: i.actualZoomFactor(), actualZoomFactor: () => i.actualZoomFactor(),
    })), p)
  })
  handle(INVOKE.syncDisarm, p => sync.disarmPounce(p.key))
  handle(INVOKE.syncPounceStatus, p => sync.pounceStatus(p.key))
  handle(INVOKE.syncFire, p => sync.fire(p.key, null, { verify: p.verify !== false }))

  /* ---------------------------------------------------------- 布局 */

  handle(INVOKE.layoutRects, p => {
    if (Array.isArray(p.rects)) instances.applyRects(p.rects)
    return { ok: true }
  })

  handle(INVOKE.layoutSet, p => { Object.assign(ctx.layout, p); return { ok: true } })

  /* ---------------------------------------------------------- Profile */

  handle(INVOKE.profileList, () => store.get('profiles', []))
  handle(INVOKE.profileSave, p => {
    const list = store.get('profiles', [])
    const idx = list.findIndex(x => x.id === p.id)
    if (idx >= 0) list[idx] = p; else list.push(p)
    store.set('profiles', list)
    return p
  })
  handle(INVOKE.profileDelete, p => {
    store.set('profiles', store.get('profiles', []).filter(x => x.id !== p.id))
    return { ok: true }
  })

  /* ---------------------------------------------------------- 任务 */

  handle(INVOKE.taskList, () => tasks.list())
  handle(INVOKE.taskSave, p => { const t = tasks.save(p); persistTasks(); return t })
  handle(INVOKE.taskDelete, p => { const r = tasks.delete(p.id); persistTasks(); return { ok: r } })
  handle(INVOKE.taskArm, p => tasks.arm(p.id))
  handle(INVOKE.taskCancel, p => tasks.cancel(p.id))
  handle(INVOKE.taskRunNow, p => tasks.runNow(p.id))

  function persistTasks() { store.set('tasks', tasks.list()) }

  /* ---------------------------------------------------------- 剧本 / 站点预设 */

  handle(INVOKE.playbookRun, async p => {
    const targets = instances.resolveTargets(p.targets || 'all', sync.masterId).filter(i => i.webContents)
    if (!targets.length) return { ok: false, reason: 'no-targets' }
    const res = await ctx.playbooks.run(p.playbook, targets, { vars: p.vars })
    push.state(fullState())
    return res
  })

  handle(INVOKE.playbookAbort, p => {
    if (p.id != null) ctx.playbooks.abort(p.id); else ctx.playbooks.abortAll()
    return { ok: true }
  })

  handle(INVOKE.presetList, () => ctx.presets.map(x => ({
    id: x.id, name: x.name, origin: x.origin, clockSource: x.clockSource,
    urls: x.urls ? { home: x.urls.home, bag: x.urls.bag, signIn: x.urls.signIn } : null,
    taskDefaults: x.taskDefaults || null,
    // 机型/尺寸/颜色/容量表交给中控台,下拉框直接照着渲染,不在 UI 里再抄一份
    models: x.models || null,
  })))

  /** 生成首发预购方案(配置剧本 + 守株目标 + 预购时刻),UI 只负责传参数 */
  handle(INVOKE.presetPlan, p => {
    const preset = ctx.presets.find(x => x.id === p.presetId)
    if (!preset || !preset.preorderPlan) return { ok: false, reason: 'unknown-preset' }
    return { ok: true, ...preset.preorderPlan(p.options || {}) }
  })

  /**
   * 套用站点预设:把时区/语言/权限刷到每个实例的 session 上,并顺手用该站自己的
   * 响应头 Date 校准一次时钟 —— 抢的是哪家的货,就对哪家的服务器对表。
   */
  handle(INVOKE.presetApply, async p => {
    const preset = ctx.presets.find(x => x.id === p.presetId)
    if (!preset) return { ok: false, reason: 'unknown-preset' }
    const targets = instances.resolveTargets(p.targets || 'all', sync.masterId)
    for (const inst of targets) {
      Object.assign(inst.profile, preset.profileDefaults, p.options || {})
      await sessionFactory.applyProfile(inst.session, inst.profile)
      if (inst.webContents) await sessionFactory.applyEmulation(inst.webContents, inst.profile)
      inst._emit()
    }
    let clockRes = null
    if (preset.clockSource) {
      // 被动采集只认这一个 host,否则 CDN/统计的响应会把校准搅乱
      sessionFactory.setClockHost(preset.clockSource)
      clockRes = await clock.syncWith(preset.clockSource, { samples: 12 }).catch(() => null)
      push.clock(clock.snapshot())
    }
    logger.info('已套用站点预设', { preset: preset.id, instances: targets.length, clock: clockRes })
    push.state(fullState())
    return { ok: true, applied: targets.length, clock: clockRes }
  })

  /* ---------------------------------------------------------- 时钟 */

  handle(INVOKE.clockSync, async p => {
    const res = await clock.syncWith(p.url, { samples: p.samples || 12 })
    push.clock(clock.snapshot())
    return res
  })
  handle(INVOKE.clockGet, () => clock.snapshot())

  /* ---------------------------------------------------------- 日志 */

  handle(INVOKE.logRecent, p => logger.recent(p.n || 200, p))
  handle(INVOKE.logClear, () => { logger.clear(); return { ok: true } })

  /* ---------------------------------------------------------- 被控页面上报 */

  ipcMain.on(GUEST.event, (e, ev) => {
    const inst = instances.byWebContents(e.sender)
    if (!inst) return
    // 以主进程认定的实例身份为准,不信页面自报的 instanceId
    ev.instanceId = inst.id
    sync.handleMasterEvent(ev)
  })

  ipcMain.on(GUEST.ready, e => {
    instances.onGuestReady(e.sender, sync.masterId, ctx.captureOpts)
  })

  ipcMain.on(GUEST.state, (e, payload) => {
    instances.onGuestState(e.sender, payload)
  })

  // 守株待兔命中:页面里的观察器发现目标元素出现了,立刻注入
  ipcMain.on(GUEST.trigger, (e, payload) => {
    const inst = instances.byWebContents(e.sender)
    if (!inst || !payload) return
    sync.handleTrigger(
      { id: inst.id, webContents: inst.webContents, boundsW: inst.bounds.w, zoomFactor: inst.actualZoomFactor(), actualZoomFactor: () => inst.actualZoomFactor() },
      payload
    )
  })
}

function pick(obj, keys) {
  const out = {}
  if (!obj) return out
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

module.exports = { register }
