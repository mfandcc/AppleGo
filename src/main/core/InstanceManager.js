'use strict'
/**
 * InstanceManager —— 实例的生命周期与批量操作。
 *
 * 也是"渲染层量格子 → 主进程摆 view"这条链路的落点:applyRects 收到中控台量好的矩形,
 * 直接转成 view.setBounds。主进程不参与任何布局计算。
 */

const { Instance } = require('./Instance.js')
const { GUEST } = require('../../shared/ipc.js')

class InstanceManager {
  /**
   * @param {object} deps { window, sessionFactory, logger, store, onChange }
   */
  constructor(deps) {
    this.window = deps.window
    this.sessionFactory = deps.sessionFactory
    this.logger = deps.logger
    this.store = deps.store
    this.onChange = deps.onChange || (() => {})
    this.onNeedsEmulationReplay = deps.onNeedsEmulationReplay || null

    this.instances = []
    this.seq = 0
    this.focusedId = null
  }

  list() { return this.instances }
  get(id) { return this.instances.find(i => i.id === id) || null }
  snapshot() { return this.instances.map(i => i.snapshot()) }

  byWebContents(wc) {
    if (!wc) return null
    for (const inst of this.instances) {
      for (const tab of inst.tabs) {
        if (!tab.view.webContents.isDestroyed() && tab.view.webContents.id === wc.id) return inst
      }
    }
    return null
  }

  /* ------------------------------------------------------------ 生命周期 */

  async create({ count = 1, profile, url } = {}) {
    const created = []
    for (let k = 0; k < count; k++) {
      const id = ++this.seq
      const prof = normalizeProfile(profile, id)
      const session = await this.sessionFactory.acquire(prof)

      const inst = new Instance({
        id,
        name: prof.name || ('实例 ' + id),
        profile: prof,
        session,
        deps: { window: this.window, logger: this.logger, onChange: (iid, snap) => this.onChange(iid, snap) },
      })
      inst.onNeedsEmulationReplay = this.onNeedsEmulationReplay
      this.instances.push(inst)

      // 顺序很重要:先建**空**标签页 → 套环境 → 再导航。
      // 反过来的话,applyEmulation 里为了把渲染进程拉起来而加载的 about:blank
      // 会把已经在进行的真实导航打断,实例变白屏;
      // 而且页面从第一个字节开始就该看到正确的时区/语言,不能等加载完再改。
      inst.createTab(null)

      const wc = inst.webContents
      if (wc) {
        this.sessionFactory.applyWebRTCPolicy(wc, prof)
        await this.sessionFactory.applyEmulation(wc, prof)
      }

      if (url) inst.navigate(url)

      created.push(inst)
      this.logger.info('实例已创建', { instanceId: id, profileId: prof.id, proxy: !!(prof.proxy && prof.proxy.rules) })
    }
    return created
  }

  remove(id) {
    const idx = this.instances.findIndex(i => i.id === id)
    if (idx < 0) return false
    const [inst] = this.instances.splice(idx, 1)
    inst.destroy()
    this.sessionFactory.release(inst.profile.id)
    if (this.focusedId === id) this.focusedId = null
    this.logger.info('实例已移除', { instanceId: id })
    return true
  }

  removeAll() {
    for (const inst of this.instances) inst.destroy()
    this.instances = []
  }

  /* ------------------------------------------------------------ 批量操作 */

  /** target: 实例 id | 'all' | 'slaves' | 'enabled' */
  resolveTargets(target, masterId) {
    if (target === 'all') return this.instances.filter(i => i.enabled)
    if (target === 'enabled') return this.instances.filter(i => i.enabled)
    if (target === 'slaves') return this.instances.filter(i => i.enabled && i.id !== masterId)
    if (Array.isArray(target)) return target.map(id => this.get(id)).filter(Boolean)
    const one = this.get(target)
    return one ? [one] : []
  }

  navigate(target, url, masterId) {
    const targets = this.resolveTargets(target, masterId)
    for (const inst of targets) inst.navigate(url)
    this.logger.info('批量导航', { count: targets.length, url })
    return targets.length
  }

  reload(target, masterId) {
    const targets = this.resolveTargets(target, masterId)
    for (const inst of targets) inst.reload()
    return targets.length
  }

  /* ------------------------------------------------------------ 布局 */

  /**
   * 中控台量好的格子矩形直接落到原生 view 上。
   * 没出现在 rects 里的实例说明被滚出了可视区,隐藏掉即可 ——
   * 实测 #6:隐藏的 view 照样能收输入、照样能测 DOM,所以隐藏不影响抢购。
   */
  applyRects(rects) {
    const byId = new Map(rects.map(r => [r.id, r]))
    for (const inst of this.instances) {
      const r = byId.get(inst.id)
      if (r && r.visible) inst.applyBounds({ x: r.x, y: r.y, w: r.w, h: r.h }, true)
      else inst.applyBounds(inst.bounds, false)
    }
  }

  setFocused(id) {
    this.focusedId = id
    return true
  }

  /* ------------------------------------------------------------ 角色 */

  applyRoles(masterId, captureOpts) {
    for (const inst of this.instances) {
      inst.setRole(inst.id === masterId ? 'master' : 'slave', captureOpts)
    }
  }

  /** 页面加载完会重新执行 preload,角色得补发一次,否则主机换页后同步会静默失效 */
  onGuestReady(wc, masterId, captureOpts) {
    const inst = this.byWebContents(wc)
    if (!inst) return null
    inst.setRole(inst.id === masterId ? 'master' : 'slave', captureOpts)
    return inst
  }

  onGuestState(wc, payload) {
    const inst = this.byWebContents(wc)
    if (!inst) return null
    inst.applyGuestState(payload)
    return inst
  }
}

let profileSeq = 0
function normalizeProfile(profile, instanceId) {
  const p = profile ? { ...profile } : {}
  if (!p.id) p.id = 'p' + instanceId + '-' + (++profileSeq)
  if (!p.name) p.name = '实例 ' + instanceId
  p.permissions = p.permissions || {}
  return p
}

module.exports = { InstanceManager, GUEST }
