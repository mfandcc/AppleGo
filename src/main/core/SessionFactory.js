'use strict'
/**
 * SessionFactory —— "独立环境"的全部实现。
 *
 * 一个实例 = 一份 Profile = 一个 Electron session。隔离边界(实测 #7 确认):
 *   cookie / localStorage / sessionStorage / IndexedDB / CacheStorage / ServiceWorker / HTTP 缓存 / 权限授予
 * 在此之上再按 profile 叠加:代理(含账号密码)、UA、Accept-Language、时区、locale、地理位置、权限策略、资源拦截。
 *
 * 合规边界:这里做的是**多账号环境管理**,不是指纹伪造。
 * 不注入 canvas/WebGL/AudioContext 噪声,不改 navigator 的硬件特征,不做任何以规避风控检测为目的的伪装。
 */

const { app, session: electronSession } = require('electron')
const path = require('path')

/** 代理鉴权凭据表:session -> {username, password}。app.on('login') 是全局事件,只能靠这张表分流。 */
const proxyCredentials = new WeakMap()
let loginHandlerInstalled = false

/** 常见的可按 profile 控制的权限 */
const DEFAULT_PERMISSIONS = {
  geolocation: false,
  notifications: false,
  media: false,
  midi: false,
  clipboardRead: false,
  fullscreen: true,
  openExternal: false,
}

/** 多开时最省资源的拦截档位 */
const BLOCK_PRESETS = {
  none: [],
  media: ['image', 'media', 'font'],
  heavy: ['image', 'media', 'font', 'stylesheet'],
}

class SessionFactory {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir   profile 落盘根目录
   * @param {object} opts.logger
   * @param {object} [opts.clock]   传进来的话,会被动采集响应头 Date 做时钟校准
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir
    this.logger = opts.logger || { info() {}, warn() {}, error() {}, debug() {} }
    this.clock = opts.clock || null
    this.sessions = new Map()      // profileId -> Session
    /** 只从这个 host 的响应里采时钟样本。null = 关闭被动采集。 */
    this.clockHost = opts.clockHost || null
    this._installLoginHandler()
  }

  /** 设定被动时钟采集的目标 host(套用站点预设时调用) */
  setClockHost(originOrUrl) {
    try {
      this.clockHost = originOrUrl ? new URL(originOrUrl).hostname : null
    } catch (e) {
      this.clockHost = null
    }
    return this.clockHost
  }

  _isClockHost(url) {
    if (!this.clockHost) return false
    try { return new URL(url).hostname === this.clockHost } catch (e) { return false }
  }

  /**
   * 代理鉴权只能挂全局 app.on('login'),这里靠 webContents.session 反查是哪个 profile 的凭据。
   * 只装一次。
   */
  _installLoginHandler() {
    if (loginHandlerInstalled) return
    loginHandlerInstalled = true
    app.on('login', (event, webContents, authenticationResponseDetails, authInfo, callback) => {
      if (!authInfo || !authInfo.isProxy) return          // 站点自身的 401 不碰,交给页面自己处理
      const ses = webContents && webContents.session
      const cred = ses && proxyCredentials.get(ses)
      if (!cred) return
      event.preventDefault()
      callback(cred.username, cred.password)
    })
  }

  partitionFor(profileId) {
    return 'persist:applego-' + String(profileId)
  }

  /**
   * 取得(必要时创建)某个 profile 的 session,并把 profile 的全部环境设置应用上去。
   * 幂等:同一个 profileId 反复调用返回同一个 session,只是重新套用最新配置。
   */
  async acquire(profile) {
    if (!profile || !profile.id) throw new Error('SessionFactory.acquire: profile.id 必填')
    let ses = this.sessions.get(profile.id)
    if (!ses) {
      ses = electronSession.fromPartition(this.partitionFor(profile.id))
      this.sessions.set(profile.id, ses)
      this._attachClockProbe(ses)
    }
    await this.applyProfile(ses, profile)
    return ses
  }

  /** 把 profile 的环境设置套到 session 上。运行中改配置也走这里。 */
  async applyProfile(ses, profile) {
    // —— 代理。必须 await 完再 loadURL,否则首个请求可能直接走了直连。
    await this.applyProxy(ses, profile.proxy)

    // —— UA 与语言
    if (profile.userAgent) ses.setUserAgent(profile.userAgent, profile.acceptLanguages || undefined)
    else if (profile.acceptLanguages) ses.setUserAgent(ses.getUserAgent(), profile.acceptLanguages)

    // —— 权限:默认全拒,只放开 profile 明确允许的。抢购场景基本不需要任何敏感权限。
    const perms = { ...DEFAULT_PERMISSIONS, ...(profile.permissions || {}) }
    ses.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(this._permissionAllowed(perms, permission))
    })
    if (ses.setPermissionCheckHandler) {
      ses.setPermissionCheckHandler((webContents, permission) => this._permissionAllowed(perms, permission))
    }

    // —— 资源拦截:N 大的时候把图片/字体挡掉能省一大截内存和带宽
    this.applyBlocking(ses, profile.blockResources)

    // —— 下载目录按 profile 分开,避免互相覆盖
    if (this.dataDir) {
      ses.setDownloadPath?.(path.join(this.dataDir, 'downloads', String(profile.id)))
    }

    return ses
  }

  _permissionAllowed(perms, permission) {
    switch (permission) {
      case 'geolocation': case 'geolocation-approximate': return !!perms.geolocation
      case 'notifications': return !!perms.notifications
      case 'media': case 'mediaKeySystem': case 'display-capture': return !!perms.media
      case 'midi': case 'midiSysex': return !!perms.midi
      case 'clipboard-read': case 'deprecated-sync-clipboard-read': return !!perms.clipboardRead
      case 'clipboard-sanitized-write': return true
      case 'fullscreen': return !!perms.fullscreen
      case 'openExternal': return !!perms.openExternal
      default: return false
    }
  }

  /** @param {{mode?:string, rules?:string, bypass?:string, pac?:string, username?:string, password?:string}} proxy */
  async applyProxy(ses, proxy) {
    if (!proxy || !proxy.rules && !proxy.pac && proxy.mode !== 'system') {
      proxyCredentials.delete(ses)
      await ses.setProxy({ mode: 'direct' })
      return
    }
    const config = proxy.pac
      ? { mode: 'pac_script', pacScript: proxy.pac, proxyBypassRules: proxy.bypass || undefined }
      : proxy.mode === 'system'
        ? { mode: 'system' }
        : { mode: 'fixed_servers', proxyRules: proxy.rules, proxyBypassRules: proxy.bypass || undefined }

    if (proxy.username) proxyCredentials.set(ses, { username: proxy.username, password: proxy.password || '' })
    else proxyCredentials.delete(ses)

    await ses.setProxy(config)

    // ⚠️ Electron 官方文档明确要求:setProxy 之后要关掉在途连接,
    // 否则连接池里还用着旧代理的 socket 会被后续请求复用 ——
    // 多账号多代理时,这等于某个账号的流量从别人的出口 IP 出去。
    try { await ses.closeAllConnections() } catch (e) { /* 老版本没有这个方法 */ }
  }

  /**
   * 挂代理时关掉非代理的 WebRTC UDP 通道。
   * 这是**防 IP 泄漏**,不是指纹伪造:不做这一步的话,页面用 WebRTC 就能拿到真实公网/内网 IP,
   * 代理等于白挂。必须在每个 webContents 上单独设。
   */
  applyWebRTCPolicy(webContents, profile) {
    if (!webContents || webContents.isDestroyed()) return
    const hasProxy = !!(profile && profile.proxy && (profile.proxy.rules || profile.proxy.pac))
    try {
      webContents.setWebRTCIPHandlingPolicy(hasProxy ? 'disable_non_proxied_udp' : 'default')
    } catch (e) { /* ignore */ }
  }

  /** 代理体检:确认这个 session 访问目标站时真的走了代理 */
  async checkProxy(ses, url) {
    try {
      const r = await ses.resolveProxy(url)
      return { ok: true, resolved: r, direct: /^DIRECT/i.test(r) }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  /** 按档位拦截资源类型。传 'none'/null 解除拦截。 */
  applyBlocking(ses, preset) {
    const types = Array.isArray(preset) ? preset : (BLOCK_PRESETS[preset] || [])
    if (!types.length) { ses.webRequest.onBeforeRequest(null); return }
    const blocked = new Set(types)
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: blocked.has(details.resourceType) })
    })
  }

  /**
   * 被动采集响应头 Date 做时钟校准 —— 页面本来就在不停请求,顺手就校准了,不用额外发探测请求。
   *
   * ⚠️ 必须**只采目标站一个 host**。
   * 一开始不加过滤,结果 CDN、统计、字体、第三方脚本的响应全被当成样本喂进来 ——
   * 不同服务器的时钟本来就差几百毫秒,区间求交集必然互相矛盾,日志被"样本与既有区间矛盾"刷屏,
   * 校准结果反复重置,等于没校准。
   */
  _attachClockProbe(ses) {
    if (!this.clock) return
    const inflight = new Map()
    ses.webRequest.onSendHeaders({ urls: ['https://*/*', 'http://*/*'] }, details => {
      inflight.set(details.id, Date.now())
      if (inflight.size > 512) inflight.clear()          // 防泄漏,丢几个样本无所谓
    })
    ses.webRequest.onHeadersReceived({ urls: ['https://*/*', 'http://*/*'] }, (details, callback) => {
      const sentAt = inflight.get(details.id)
      inflight.delete(details.id)
      // 只认目标 host,其它一律不当样本
      if (!this._isClockHost(details.url)) { callback({ responseHeaders: details.responseHeaders }); return }
      const headers = details.responseHeaders || {}
      const dateKey = Object.keys(headers).find(k => k.toLowerCase() === 'date')
      if (sentAt != null && dateKey) {
        // 命中缓存的响应带 Age 头,它的 Date 是旧的,会毒化校准,直接跳过
        const hasAge = Object.keys(headers).some(k => k.toLowerCase() === 'age')
        if (!hasAge) {
          const raw = Array.isArray(headers[dateKey]) ? headers[dateKey][0] : headers[dateKey]
          try { this.clock.observe(raw, sentAt, Date.now()) } catch (e) { /* 校准失败不能影响请求 */ }
        }
      }
      callback({ responseHeaders: details.responseHeaders })
    })
  }

  /**
   * 每实例的时区 / locale / 地理位置覆盖(实测 #8:CDP 作用域就是单个 webContents)。
   * ⚠️ debugger 与 DevTools 互斥,开 DevTools 前要先 detach。
   */
  async applyEmulation(webContents, profile) {
    const wants = profile.timezone || profile.locale || profile.geo
    if (!wants) return { ok: true, skipped: true }
    if (!webContents || webContents.isDestroyed()) return { ok: false, reason: 'destroyed' }

    // ⚠️ 全新的 WebContentsView 还没有渲染进程,此时发 CDP 命令会**永远不 resolve**(不是报错,是挂住)。
    // 先给它一张空白页把渲染进程拉起来,CDP 才有对端。
    if (!webContents.getURL()) {
      try { await withTimeout(webContents.loadURL('about:blank'), 3000, 'blank') } catch (e) { /* 继续尝试 */ }
    }

    const dbg = webContents.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
    } catch (err) {
      this.logger.warn('无法 attach debugger,时区/语言覆盖跳过(通常是 DevTools 开着)', { err: String(err) })
      return { ok: false, reason: 'attach-failed' }
    }

    // 每条命令都套超时:CDP 一旦挂住,整个实例创建流程就卡死了,而这只是个锦上添花的功能,
    // 绝不能让它有能力拖垮主流程。
    const send = (method, params) =>
      withTimeout(dbg.sendCommand(method, params), 2500, method)

    try {
      if (profile.timezone) await send('Emulation.setTimezoneOverride', { timezoneId: profile.timezone })
      if (profile.locale) await send('Emulation.setLocaleOverride', { locale: profile.locale })
      if (profile.geo) {
        await send('Emulation.setGeolocationOverride', {
          latitude: profile.geo.latitude, longitude: profile.geo.longitude, accuracy: profile.geo.accuracy || 50,
        })
      }
      return { ok: true }
    } catch (err) {
      this.logger.warn('时区/语言覆盖失败(不影响其它功能)', { err: String(err && err.message || err) })
      return { ok: false, reason: String(err && err.message || err) }
    }
  }

  /** 释放该实例的 debugger,好让用户能开 DevTools */
  detachEmulation(webContents) {
    try { if (webContents.debugger.isAttached()) webContents.debugger.detach() } catch (e) { /* ignore */ }
  }

  /** 清空某个 profile 的全部环境数据(退登、换号) */
  async reset(profileId, { keepCookies = false } = {}) {
    const ses = this.sessions.get(profileId)
    if (!ses) return false
    const storages = ['localstorage', 'indexdb', 'websql', 'shadercache', 'serviceworkers', 'cachestorage']
    if (!keepCookies) storages.push('cookies')
    await ses.clearStorageData({ storages })
    await ses.clearCache()
    await ses.clearAuthCache?.()
    this.logger.info('已重置实例环境', { profileId, keepCookies })
    return true
  }

  /** 把 A 的登录态复制到 B(批量开号时很有用:登录一次,克隆 N 份) */
  async cloneCookies(fromProfileId, toProfileId) {
    const from = this.sessions.get(fromProfileId)
    const to = this.sessions.get(toProfileId)
    if (!from || !to) return { ok: false, reason: 'session-not-found' }
    const cookies = await from.cookies.get({})
    let n = 0
    for (const c of cookies) {
      const url = (c.secure ? 'https://' : 'http://') + (c.domain || '').replace(/^\./, '') + (c.path || '/')
      try {
        await to.cookies.set({
          url, name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite,
        })
        n++
      } catch (e) { /* 个别 cookie 设不进去很正常,跳过 */ }
    }
    this.logger.info('已克隆 cookie', { fromProfileId, toProfileId, count: n, total: cookies.length })
    return { ok: true, count: n, total: cookies.length }
  }

  release(profileId) { this.sessions.delete(profileId) }
}

/** 给任何"理论上该很快、但挂住就要命"的 promise 套一层硬超时 */
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_res, rej) => { timer = setTimeout(() => rej(new Error('timeout:' + (label || 'op'))), ms) }),
  ])
}

module.exports = { SessionFactory, BLOCK_PRESETS, DEFAULT_PERMISSIONS, withTimeout }
