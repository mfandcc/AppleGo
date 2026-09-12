'use strict'
/**
 * Instance —— 一个"多开位":一份独立环境 + 若干标签页。
 *
 * 【统一逻辑视口】
 * 网格里每个格子的物理尺寸可能只有 400×300,但如果就让页面按 400px 宽渲染,
 * 各实例会落进不同的响应式断点 —— 主机是桌面版布局、从机是移动版布局,同步必然打偏。
 * 所以这里反过来用 zoomFactor:令 zoom = 格子物理宽 / 逻辑宽(默认 1280),
 * 页面永远以为自己有 1280px 可用,所有实例的布局完全一致。
 * 实测 #9 说明 zoom 会改变注入坐标的换算关系 —— 那个坑在这里变成了地基,
 * 换算统一由 InputCodec.toViewCoords(cssX, cssY, zoomFactor) 处理。
 */

const { WebContentsView } = require('electron')
const path = require('path')

const GUEST_PRELOAD = path.join(__dirname, '../../preload/guest.js')

const DEFAULT_LOGICAL_WIDTH = 1280
// ⚠️ Chromium 的布局缩放在 0.25 触底,但 getZoomFactor() 不会告诉你它被钳位了(实测 #14)。
// 所以名义 zoom 只是"我们请求的值",真正能用来换算坐标的是回读 innerWidth 反算出来的 effectiveZoom。
const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
/** 格子物理宽度低于这个值,逻辑视口就撑不到 logicalWidth 了 */
const MIN_CELL_W = 1280 * ZOOM_MIN

let tabSeq = 0

class Instance {
  /**
   * @param {object} opts
   * @param {number} opts.id
   * @param {string} opts.name
   * @param {object} opts.profile
   * @param {Electron.Session} opts.session
   * @param {object} opts.deps { window, logger, onEvent }
   */
  constructor(opts) {
    this.id = opts.id
    this.name = opts.name || ('实例 ' + opts.id)
    this.profile = opts.profile
    this.session = opts.session
    this.window = opts.deps.window
    this.logger = opts.deps.logger
    this.onChange = opts.deps.onChange || (() => {})

    this.enabled = true
    this.status = 'idle'
    this.statusHint = null
    this.role = 'slave'
    this.lastSyncMs = null

    this.tabs = []
    this.activeTabId = null

    this.bounds = { x: 0, y: 0, w: 0, h: 0 }
    this.visible = true
    this.uniformViewport = opts.uniformViewport !== false
    this.logicalWidth = opts.logicalWidth || DEFAULT_LOGICAL_WIDTH
    /** 名义缩放:我们请求的值 */
    this.zoomFactor = 1
    /** 实际生效的缩放 = 格子物理宽 / 页面 innerWidth。**坐标换算只许用这个。** */
    this.effectiveZoom = 1
    this.viewportWarned = false
    this._measuring = false
    this._measuredW = null
    this._measuredZoom = null
    this._measuredUrl = null
    this._measuredAt = 0
  }

  /* ------------------------------------------------------------ 标签页 */

  createTab(url) {
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: GUEST_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,               // preload 要 require 本地模块
        backgroundThrottling: false,  // 不可见的实例也要正常跑定时器/网络
        webSecurity: true,
        spellcheck: false,
      },
    })
    // Electron 的 loadURL 内部会挂 did-stop-loading 监听器,一个标签页生命周期里会导航很多次;
    // 默认上限 10 会刷一堆 MaxListenersExceededWarning。这里给一个明确的、够用的上限,
    // 而不是无限放开 —— 真有泄漏时仍然会报出来。
    try { view.webContents.setMaxListeners(40) } catch (e) { /* ignore */ }

    const tab = { id: ++tabSeq, view, url: url || null, title: '', loading: false }
    this.tabs.push(tab)
    this.window.contentView.addChildView(view)
    this._wireTab(tab)

    if (this.activeTabId == null) this.activate(tab.id)
    else view.setVisible(false)

    if (url) this.navigate(url, tab.id)
    return tab
  }

  _wireTab(tab) {
    const wc = tab.view.webContents

    wc.on('did-start-loading', () => { tab.loading = true; this._setStatus('loading') })
    wc.on('did-stop-loading', () => { tab.loading = false; if (this.status === 'loading') this._setStatus('ready') })
    wc.on('did-finish-load', () => { tab.url = wc.getURL(); tab.title = wc.getTitle(); this._applyZoom({ force: true }); this._emit() })
    wc.on('dom-ready', () => this._applyZoom({ force: true }))
    wc.on('page-title-updated', (_e, title) => { tab.title = title; this._emit() })
    wc.on('did-navigate', (_e, url) => { tab.url = url; this._applyZoom({ force: true }); this._emit() })
    wc.on('did-navigate-in-page', (_e, url) => { tab.url = url; this._emit() })

    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return    // -3 = 用户中止,正常
      this._setStatus('error', `${desc} (${code})`)
      this.logger.warn('页面加载失败', { instanceId: this.id, url, code, desc })
    })

    wc.on('render-process-gone', (_e, details) => {
      this._setStatus('error', '渲染进程崩溃: ' + details.reason)
      this.logger.error('渲染进程崩溃', { instanceId: this.id, reason: details.reason })
      // 实测 #12:CDP 的时区/语言覆盖能挺过导航,但挺不过 target 重建 —— 崩溃后必须重放
      if (this.onNeedsEmulationReplay) this.onNeedsEmulationReplay(this)
    })

    wc.on('unresponsive', () => this._setStatus('error', '页面无响应'))
    wc.on('responsive', () => this._setStatus('ready'))

    // 把 window.open 收进本实例的标签页体系,而不是弹出一个游离的 OS 窗口
    wc.setWindowOpenHandler(({ url }) => {
      this.createTab(url)
      return { action: 'deny' }
    })
  }

  activate(tabId) {
    const tab = this.tabs.find(t => t.id === tabId)
    if (!tab) return false
    this.activeTabId = tabId
    for (const t of this.tabs) t.view.setVisible(t.id === tabId && this.visible)
    // addChildView 对已存在的子 view 再调一次 = 提到最顶层
    this.window.contentView.addChildView(tab.view)
    this.applyBounds(this.bounds, this.visible)
    this._emit()
    return true
  }

  closeTab(tabId) {
    const idx = this.tabs.findIndex(t => t.id === tabId)
    if (idx < 0) return false
    const [tab] = this.tabs.splice(idx, 1)
    this._destroyTab(tab)
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)]
      this.activeTabId = null
      if (next) this.activate(next.id)
    }
    this._emit()
    return true
  }

  _destroyTab(tab) {
    try { this.window.contentView.removeChildView(tab.view) } catch (e) { /* 窗口可能已销毁 */ }
    try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close() } catch (e) { /* ignore */ }
  }

  get activeTab() { return this.tabs.find(t => t.id === this.activeTabId) || null }
  get view() { const t = this.activeTab; return t ? t.view : null }
  get webContents() { const t = this.activeTab; return t && !t.view.webContents.isDestroyed() ? t.view.webContents : null }
  get url() { const t = this.activeTab; return t ? t.url : null }

  /* ------------------------------------------------------------ 布局 */

  /**
   * 摆放到渲染层量出来的矩形上。
   * @param {{x:number,y:number,w:number,h:number}} rect
   * @param {boolean} visible
   */
  applyBounds(rect, visible = true) {
    this.bounds = rect
    this.visible = visible !== false

    // 统一逻辑视口:让所有实例的页面都以为自己有同样的宽度
    const nextZoom = this.uniformViewport && rect.w > 0
      ? clamp(rect.w / this.logicalWidth, ZOOM_MIN, ZOOM_MAX)
      : 1

    if (Math.abs(nextZoom - this.zoomFactor) > 0.002) this.viewportWarned = false
    this.zoomFactor = nextZoom
    if (this.effectiveZoom === 1 && nextZoom !== 1) this.effectiveZoom = nextZoom   // 首帧先用名义值兜底

    for (const tab of this.tabs) {
      const isActive = tab.id === this.activeTabId
      tab.view.setVisible(isActive && this.visible)
      if (!isActive) continue
      tab.view.setBounds({ x: rect.x, y: rect.y, width: Math.max(1, rect.w), height: Math.max(1, rect.h) })
    }
    this._applyZoom()
  }

  /**
   * 把 zoomFactor 真正落到活动标签页上。
   *
   * ⚠️ Chromium 的缩放是按 origin 记的,**导航之后会被重置**。
   * 如果只在 applyBounds 里设一次,页面一跳转 zoomFactor 就悄悄回到 1,
   * 而 this.zoomFactor 还停在旧值 —— 于是 InputCodec 会按一个根本没生效的缩放去换算坐标,
   * 注入点整体偏移,从机全部打空。所以每次导航完都要重新施加一次。
   */
  _applyZoom({ force = false } = {}) {
    const wc = this.webContents
    if (!wc) return
    if (Math.abs(wc.getZoomFactor() - this.zoomFactor) > 0.001) {
      wc.setZoomFactor(this.zoomFactor)
    }
    this._measureEffectiveZoom({ force })
  }

  /**
   * 回读页面真实的 innerWidth,反算出**实际生效**的缩放。
   *
   * 为什么不能信 getZoomFactor():实测 #14 —— 格子太窄时 Chromium 会把布局缩放钳在 0.25,
   * 但 getZoomFactor() 照样返回你请求的 0.1。拿这个假值去换算坐标,注入点会整体偏移、全部打空。
   * 这里改成测量:effectiveZoom = 格子物理宽 / 页面 innerWidth,不管 Chromium 内部怎么钳都对。
   */
  _measureEffectiveZoom({ force = false } = {}) {
    const wc = this.webContents
    if (!wc || !this.bounds.w) return

    // about:blank 有自己的 origin,缩放不跟着目标站走,量出来的是假值。
    // 之前没排除它,结果:空白页上量到 effectiveZoom=1 被缓存下来,真实页面加载完又因为节流不再复测,
    // 于是所有注入坐标都按 zoom=1 换算 —— 整整差了 2.6 倍,从机全部点空。
    const url = wc.getURL()
    if (!url || url === 'about:blank' || url.startsWith('chrome-error://')) return

    // 中控台每次重排都会上报一次矩形,applyBounds 因此调用得非常频繁。
    // 若每次都往页面发一次 executeJavaScript:
    //   ① 纯属浪费(尺寸没变时结果也不会变);
    //   ② 页面**正在加载**时 Electron 会把 executeJavaScript 排队等 did-stop-loading,
    //      每排一次就挂一个监听器,几十次之后就是 MaxListenersExceededWarning,是真的泄漏。
    // 所以:加载中不测,尺寸没变且刚测过也不测,并且同一时刻只允许一个测量在飞。
    if (this._measuring) return
    if (!force && wc.isLoading && wc.isLoading()) return
    const now = Date.now()
    const sameBox = this._measuredW === this.bounds.w
      && this._measuredZoom === this.zoomFactor
      && this._measuredUrl === url
    if (!force && sameBox && this._measuredAt && now - this._measuredAt < 1000) return

    this._measuring = true
    this._measuredW = this.bounds.w
    this._measuredZoom = this.zoomFactor
    this._measuredUrl = url
    this._measuredAt = now

    wc.executeJavaScript('window.innerWidth', false).then(innerWidth => {
      if (!innerWidth || innerWidth <= 0) return
      const next = this.bounds.w / innerWidth

      // ⚠️ 刚 setBounds 完、页面还没重新布局时,innerWidth 可能是个过渡值(实测见过 2),
      // 算出来的"缩放"会是 345 这种荒谬数字,拿去换算坐标就是把点打到银河系外。
      // zoomFactor 本身被钳在 [0.25, 3],所以任何落在这个范围之外的测量值一定是脏数据:
      // 丢掉它,清掉节流标记让下一次重测。
      if (!(next >= ZOOM_MIN * 0.8 && next <= ZOOM_MAX * 1.2)) {
        this._measuredAt = 0
        this.logger.debug('丢弃一次过渡期的缩放测量', {
          instanceId: this.id, 格子宽: this.bounds.w, 测到的视口宽: innerWidth, 算出的缩放: next,
        })
        return
      }
      if (Math.abs(next - this.effectiveZoom) > 0.002) {
        this.effectiveZoom = next
        this._emit()
      }
      // 名义和实际差太多,说明格子已经窄到撑不起逻辑视口了,提醒一次
      if (Math.abs(next - this.zoomFactor) > 0.02 && !this.viewportWarned) {
        this.viewportWarned = true
        this.logger.warn('格子太窄,逻辑视口被 Chromium 钳位', {
          instanceId: this.id, 格子宽: this.bounds.w, 建议最小宽: MIN_CELL_W,
          名义zoom: +this.zoomFactor.toFixed(3), 实际zoom: +next.toFixed(3), 实际视口宽: innerWidth,
        })
      }
    }).catch(() => {
      // 页面还没起来,下次 applyBounds 会再测
      this._measuredAt = 0
    }).finally(() => { this._measuring = false })
  }

  /** 坐标换算唯一该用的缩放值 */
  actualZoomFactor() { return this.effectiveZoom }

  /* ------------------------------------------------------------ 操作 */

  navigate(url, tabId) {
    const tab = tabId ? this.tabs.find(t => t.id === tabId) : this.activeTab
    if (!tab) return false
    tab.url = url
    this._setStatus('loading')
    tab.view.webContents.loadURL(url).catch(err => {
      this._setStatus('error', String(err && err.message || err))
    })
    return true
  }

  reload() {
    const wc = this.webContents
    if (!wc) return false
    wc.reload()
    return true
  }

  setRole(role, captureOpts) {
    this.role = role
    const wc = this.webContents
    if (wc) {
      try { wc.send(require('../../shared/ipc.js').GUEST.role, { instanceId: this.id, role, captureOpts }) }
      catch (e) { /* 页面还没起来,ready 时会补发 */ }
    }
    this._emit()
  }

  openDevTools() {
    const wc = this.webContents
    if (!wc) return false
    // debugger 与 DevTools 互斥,开之前先松开
    try { if (wc.debugger.isAttached()) wc.debugger.detach() } catch (e) { /* ignore */ }
    wc.openDevTools({ mode: 'detach' })
    return true
  }

  _setStatus(status, hint) {
    if (this.status === status && this.statusHint === (hint || null)) return
    this.status = status
    this.statusHint = hint || null
    this._emit()
  }

  /** guest preload 上报的页面状态 */
  applyGuestState(s) {
    if (s.humanNeeded) this._setStatus('needs-human', '检测到验证码/风控拦截,需要人工处理')
    else if (this.status === 'needs-human') this._setStatus('ready')
    const tab = this.activeTab
    if (tab) { tab.url = s.href; tab.title = s.title }
    this._emit()
  }

  _emit() { this.onChange(this.id, this.snapshot()) }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      status: this.status,
      statusHint: this.statusHint,
      role: this.role,
      url: this.url,
      title: this.activeTab ? this.activeTab.title : '',
      zoomFactor: +this.zoomFactor.toFixed(3),
      effectiveZoom: +this.effectiveZoom.toFixed(3),
      lastSyncMs: this.lastSyncMs,
      profileId: this.profile ? this.profile.id : null,
      proxyLabel: proxyLabel(this.profile),
      timezone: this.profile ? this.profile.timezone : null,
      tabs: this.tabs.map(t => ({ id: t.id, url: t.url, title: t.title, loading: t.loading })),
      activeTabId: this.activeTabId,
    }
  }

  destroy() {
    for (const tab of this.tabs) this._destroyTab(tab)
    this.tabs = []
    this.activeTabId = null
  }
}

function proxyLabel(profile) {
  const p = profile && profile.proxy
  if (!p || (!p.rules && !p.pac && p.mode !== 'system')) return null
  if (p.mode === 'system') return '系统代理'
  if (p.pac) return 'PAC'
  return String(p.rules).replace(/^https?=|^socks5?:\/\//i, '').slice(0, 28)
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

module.exports = { Instance, DEFAULT_LOGICAL_WIDTH, ZOOM_MIN, ZOOM_MAX, MIN_CELL_W }
