'use strict'
/**
 * AppleGo 主进程入口。
 *
 * 窗口模型:**一个宿主窗口**。
 *   - 窗口自身的 webContents 渲染中控台(玻璃底板、工具条、网格外框、侧栏)
 *   - 每个实例的 WebContentsView 叠在它之上,位置由中控台量好后上报
 * 这样中控 UI 与被控页面永远同属一个 focused 窗口,输入注入最稳
 * (实测 #10 显示失焦也能注入,但不依赖这一点)。
 */

const { app, BrowserWindow, session, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const { Logger } = require('./core/Logger.js')
const { Store } = require('./core/Store.js')
const { Clock } = require('./core/Clock.js')
const { SessionFactory } = require('./core/SessionFactory.js')
const { GuestRpc } = require('./core/GuestRpc.js')
const { SyncEngine } = require('./core/SyncEngine.js')
const { InstanceManager } = require('./core/InstanceManager.js')
const { TaskScheduler } = require('./core/TaskScheduler.js')
const { PlaybookRunner } = require('./core/PlaybookRunner.js')
const appleCn = require('../shared/presets/apple-cn.js')
const { register } = require('./ipc/handlers.js')
const { PUSH } = require('../shared/ipc.js')

const IS_DEV = process.argv.includes('--dev')

// 多开时每个渲染进程都要内存,把上限提一点;同时关掉后台节流的全局开关
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

let ctx = null

function createWindow(logger) {
  const isMac = process.platform === 'darwin'

  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#3E5C68',
    // macOS:红绿灯浮在左上角,用 hiddenInset 把它嵌进自绘顶栏。
    // Windows/Linux:用 hidden + titleBarOverlay,系统把最小化/最大化/关闭画在右上角,
    //   颜色跟随顶栏底色,免得出现一条突兀的系统标题栏。
    titleBarStyle: 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 16 } }
      : { titleBarOverlay: { color: '#3E5C68', symbolColor: '#FFFFFF', height: 62 } }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/control.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })
  win.loadFile(path.join(__dirname, '../renderer/control/index.html'))
  win.once('ready-to-show', () => { win.show(); if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' }) })

  // 中控台里的外链一律用系统浏览器打开,不在应用里游离出新窗口
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  return win
}

async function boot() {
  const userData = app.getPath('userData')
  const dataDir = path.join(userData, 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  /* ---------------------------------------------------------- 基础设施 */

  let win = null
  const push = {
    _send(channel, payload) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        try { win.webContents.send(channel, payload) } catch (e) { /* 窗口正在关 */ }
      }
    },
    state(s) { this._send(PUSH.state, s) },
    instance(id, patch) { this._send(PUSH.instance, { id, patch }) },
    log(e) { this._send(PUSH.log, e) },
    syncRecord(r) { this._send(PUSH.syncRecord, r) },
    clock(c) { this._send(PUSH.clock, c) },
    task(t) { this._send(PUSH.task, t) },
    toast(level, text) { this._send(PUSH.toast, { level, text }) },
    openPanel(panel) { this._send(PUSH.openPanel, { panel }) },
  }

  const logger = new Logger({
    dir: path.join(userData, 'logs'),
    level: IS_DEV ? 'debug' : 'info',
    onEntry: e => push.log(e),
  })
  logger.info('AppleGo 启动', { electron: process.versions.electron, node: process.versions.node, userData })

  const store = new Store(path.join(dataDir, 'config.json'),
    { profiles: [], tasks: [], settings: {} }, { log: (l, m, d) => logger.log(l, m, d) })
  store.loadSync()

  const clock = new Clock({ log: (l, m, d) => logger.log(l, m, d) })
  const sessionFactory = new SessionFactory({ dataDir, logger, clock })
  const rpc = new GuestRpc({ logger })

  win = createWindow(logger)

  /* ---------------------------------------------------------- 核心 */

  const captureOpts = { hover: true, hoverThrottleMs: 40, keys: true, wheel: true }
  const layout = { cols: 'auto' }

  const instances = new InstanceManager({
    window: win, sessionFactory, logger, store,
    onChange: (id, snap) => push.instance(id, snap),
    // 渲染进程崩溃会重建 target,CDP 的时区/语言覆盖随之丢失,必须重放(实测 #12)
    onNeedsEmulationReplay: inst => {
      if (inst.webContents) sessionFactory.applyEmulation(inst.webContents, inst.profile)
    },
  })

  const sync = new SyncEngine({
    rpc, logger,
    getInstances: () => instances.list().map(i => ({
      id: i.id, enabled: i.enabled,
      // 用**实际生效**的缩放,不是名义值 —— getZoomFactor() 在格子过窄时会说谎(实测 #14)。
      // boundsW 交给 SyncEngine,让它用页面回报的 innerWidth 当场现算,连测量延迟都省掉。
      zoomFactor: i.actualZoomFactor(), boundsW: i.bounds.w,
      actualZoomFactor: () => i.actualZoomFactor(),
      webContents: i.webContents,
    })).filter(i => i.webContents),
    onRecord: rec => {
      push.syncRecord(rec)
      // 把每台从机这次的耗时回填到实例卡片上
      for (const r of rec.results || []) {
        const inst = instances.get(r.instanceId)
        if (inst) { inst.lastSyncMs = rec.latencyMs; }
      }
    },
  })

  const tasks = new TaskScheduler({
    clock, sync, instances, logger,
    onChange: (task, next) => { if (task) push.task(task); if (next !== undefined) push.task(next) },
  })

  // 恢复上次保存的任务(不自动布防,避免重启后误触发)
  for (const t of store.get('tasks', [])) { try { tasks.save({ ...t, state: 'idle' }) } catch (e) { /* 旧版本数据 */ } }

  const playbooks = new PlaybookRunner({ rpc, logger, clock })

  ctx = {
    win, instances, sync, clock, tasks, logger, sessionFactory, store, rpc, push, captureOpts, layout,
    playbooks,
    presets: [appleCn],
    setMaster(id) {
      sync.setMaster(id)
      instances.applyRoles(id, captureOpts)
      logger.info('主机已切换', { masterId: id })
    },
  }

  register(ctx)

  // 中控台重新加载后要把状态重推一遍
  win.webContents.on('did-finish-load', () => { if (ctx.fullState) push.state(ctx.fullState()) })

  // 渲染层的报错必须进主日志。否则中控 UI 一崩,界面只是"看起来怪怪的",
  // 日志里干干净净,根本无从查起(调试时吃过这个亏)。
  win.webContents.on('console-message', (event) => {
    const level = event.level
    if (level !== 'error' && level !== 'warning') return
    const msg = String(event.message || '')
    // Electron 自己的开发期告警(带 %c 样式前缀)不是中控台的问题,别混进事件流刷屏
    if (msg.startsWith('%c') || msg.includes('Electron Security Warning')) return
    logger.log(level === 'error' ? 'error' : 'warn', '中控台: ' + msg,
      { source: event.sourceId, line: event.lineNumber })
  })
  win.webContents.on('render-process-gone', (_e, d) => logger.error('中控台渲染进程崩溃', { reason: d.reason }))

  win.on('closed', () => {
    tasks.disposeAll()
    instances.removeAll()
    win = null
  })

  // 首次启动给一个实例,省得开局是空屏。
  // --seed N / --url X 用于开发期一次拉起多个实例做验证。
  const seedArg = process.argv.find(a => a.startsWith('--seed='))
  const urlArg = process.argv.find(a => a.startsWith('--url='))
  const seed = seedArg ? Math.max(1, Number(seedArg.split('=')[1]) || 1) : 1
  const seedUrl = urlArg ? urlArg.split('=').slice(1).join('=') : null

  if (!instances.list().length) {
    await instances.create({ count: seed, url: seedUrl })
    ctx.setMaster(instances.list()[0].id)
    if (ctx.fullState) push.state(ctx.fullState())
  }

  // 开发参数:--open=apple|task 启动后直接把面板拉起来,免得每次手点
  const openArg = process.argv.find(a => a.startsWith('--open='))
  if (openArg) {
    const panel = openArg.split('=')[1]
    win.webContents.once('did-finish-load', () => setTimeout(() => push.openPanel(panel), 1200))
  }

  app.on('before-quit', async () => {
    tasks.disposeAll()
    store.set('tasks', tasks.list())
    await store.flush()
    await logger.close()
  })
}

app.whenReady().then(boot).catch(err => {
  console.error('启动失败:', err)
  app.exit(1)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) boot() })

// 被控页面是第三方站点,任何一个抛出的未处理 rejection 都不该带崩整个中控
process.on('unhandledRejection', reason => {
  if (ctx && ctx.logger) ctx.logger.error('未处理的 Promise rejection', { reason: String(reason) })
  else console.error('unhandledRejection', reason)
})
