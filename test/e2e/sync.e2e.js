'use strict'
/**
 * 主从同步端到端验证 —— 跑的是真实的 InstanceManager / SyncEngine / guest preload,
 * 不是模拟件。
 *
 * 【怎么模拟"真人点了主机"】
 * 实测 #2:sendInputEvent 注入的事件 isTrusted === true,页面和 preload 都分不出真假。
 * 这个性质在这里正好帮了我们:对主机注入一次点击,主机的 preload 会当成真实用户操作捕获并上报,
 * 于是整条链路(捕获 → 上报 → 分发 → 从机解析 → 从机注入)全部真实跑一遍。
 *
 * 跑法:npm run test:e2e:sync
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const http = require('http')

const { Logger } = require('../../src/main/core/Logger.js')
const { Clock } = require('../../src/main/core/Clock.js')
const { SessionFactory } = require('../../src/main/core/SessionFactory.js')
const { GuestRpc } = require('../../src/main/core/GuestRpc.js')
const { SyncEngine } = require('../../src/main/core/SyncEngine.js')
const { InstanceManager } = require('../../src/main/core/InstanceManager.js')
const { GUEST } = require('../../src/shared/ipc.js')
const { ipcMain } = require('electron')

const N = 4
const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
function check(name, cond, detail) {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? '  ✔' : '  ✖'} ${name}${detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`)
}

/** 从机故意和主机长得不一样,用来证明语义同步是真的在"找元素"而不是抄坐标 */
function shopPage(variant) {
  const banner = variant === 'diff'
    ? '<div style="height:150px;background:#fef3c7;padding:20px">🎁 仅该实例可见的活动横幅</div>' : ''
  const extra = variant === 'diff'
    ? '<div style="padding:16px"><button data-testid="buy-other">立即抢购</button></div>' : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>shop</title><style>
    body{margin:0;font:15px system-ui}
    .buy{padding:14px 40px;font-size:17px;background:#f43f5e;color:#fff;border:0;border-radius:8px}
  </style></head><body>
    ${banner}
    <div style="padding:24px">
      <h1>限量联名球鞋</h1>
      ${extra}
      <div style="height:40px"></div>
      <button class="buy" id="buy-now" data-testid="buy-now">立即抢购</button>
    </div>
    <div style="height:1200px"></div>
    <script>
      window.__hits=[]
      document.getElementById('buy-now').addEventListener('click',e=>{
        window.__hits.push({what:'buy-now',trusted:e.isTrusted,x:e.clientX,y:e.clientY,t:Date.now()})
      })
      document.addEventListener('click',e=>{
        const id=(e.target&&(e.target.getAttribute&&e.target.getAttribute('data-testid')))||e.target.tagName
        if(id!=='buy-now') window.__hits.push({what:'OTHER:'+id,trusted:e.isTrusted,t:Date.now()})
      },true)
    </script>
  </body></html>`
}

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(shopPage(req.url.includes('diff') ? 'diff' : 'plain'))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const BASE = `http://127.0.0.1:${server.address().port}/`

  const win = new BrowserWindow({ width: 1400, height: 900, show: true, backgroundColor: '#7A92A0' })
  const logger = new Logger({ level: 'warn' })
  const clock = new Clock()
  const sessionFactory = new SessionFactory({ dataDir: path.join(app.getPath('temp'), 'applego-e2e'), logger, clock })
  const rpc = new GuestRpc({ logger })

  const instances = new InstanceManager({ window: win, sessionFactory, logger, store: null, onChange: () => {} })
  const sync = new SyncEngine({
    rpc, logger,
    getInstances: () => instances.list().map(i => ({
      id: i.id, enabled: i.enabled, zoomFactor: i.zoomFactor, webContents: i.webContents,
    })).filter(i => i.webContents),
  })

  // 接上真实的 IPC 布线(和 handlers.js 里一致)
  ipcMain.on(GUEST.event, (e, ev) => {
    const inst = instances.byWebContents(e.sender)
    if (!inst) return
    ev.instanceId = inst.id                       // 不信页面自报的身份
    sync.handleMasterEvent(ev)
  })
  ipcMain.on(GUEST.ready, e => instances.onGuestReady(e.sender, sync.masterId, { hover: false, keys: true, wheel: true }))

  // 建实例:1 号是主机(plain),其余是从机,其中 3、4 号布局和主机不同
  await instances.create({ count: N })
  const urls = [BASE, BASE, BASE + '?diff', BASE + '?diff']
  instances.list().forEach((inst, i) => inst.navigate(urls[i]))

  // 摆成 2×2 网格
  const cellW = 690, cellH = 430
  instances.list().forEach((inst, i) => {
    inst.applyBounds({ x: (i % 2) * (cellW + 10), y: Math.floor(i / 2) * (cellH + 10), w: cellW, h: cellH }, true)
  })

  sync.setMaster(instances.list()[0].id)
  instances.applyRoles(sync.masterId, { hover: false, keys: true, wheel: true })
  sync.setMode('auto')
  sync.setEnabled(true)

  win.focus()
  await sleep(2500)

  const master = instances.list()[0]
  const slaves = instances.list().slice(1)

  check('全部实例加载完成', instances.list().every(i => i.webContents && !i.webContents.isDestroyed()))
  const zooms = instances.list().map(i => +i.zoomFactor.toFixed(3))
  check('统一逻辑视口:所有实例 zoomFactor 一致', new Set(zooms).size === 1, { zooms })
  const viewports = await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('[innerWidth,innerHeight]')))
  check('所有实例的页面视口一致(布局才可比)', new Set(viewports.map(v => v[0])).size === 1, { viewports })

  // ---- 主机角色已生效?
  const roles = await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__appleGo.getRole()')))
  check('只有主机处于捕获态', roles[0] === 'master' && roles.slice(1).every(r => r === 'slave'), { roles })

  // ---- 关键动作:对主机注入一次点击,模拟真人操作
  const rect = await master.webContents.executeJavaScript(
    `(()=>{const r=document.getElementById('buy-now').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
  const z = master.actualZoomFactor()
  check('页面实际缩放与记录一致(否则坐标换算全错)', Math.abs(z - master.zoomFactor) < 0.001,
    { 记录: master.zoomFactor, 实际: z })
  const vx = Math.round(rect.x * z), vy = Math.round(rect.y * z)
  master.webContents.sendInputEvent({ type: 'mouseMove', x: vx, y: vy })
  master.webContents.sendInputEvent({ type: 'mouseDown', x: vx, y: vy, button: 'left', clickCount: 1 })
  master.webContents.sendInputEvent({ type: 'mouseUp', x: vx, y: vy, button: 'left', clickCount: 1 })

  await sleep(1600)

  const hits = await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__hits')))
  const masterHits = hits[0]
  const slaveHits = hits.slice(1)

  check('主机自己收到 1 次点击', masterHits.filter(h => h.what === 'buy-now').length === 1, { masterHits })
  check('所有从机都点中了「立即抢购」',
    slaveHits.every(h => h.filter(x => x.what === 'buy-now').length === 1),
    { 各从机命中次数: slaveHits.map(h => h.filter(x => x.what === 'buy-now').length) })
  check('从机的点击是可信事件', slaveHits.every(h => h.every(x => x.trusted)))
  check('没有点到别的元素(布局不同的从机也没打偏)',
    slaveHits.every(h => h.every(x => x.what === 'buy-now')),
    { 误点: slaveHits.flat().filter(x => x.what !== 'buy-now') })

  // ---- 自激检测:再等一会儿,点击次数不能继续涨
  await sleep(1500)
  const hits2 = await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__hits.length')))
  const total1 = hits.reduce((s, h) => s + h.length, 0)
  const total2 = hits2.reduce((s, n) => s + n, 0)
  check('没有自激循环(点击次数不再增长)', total1 === total2, { 之前: total1, 之后: total2 })

  const stats = sync.stats()
  check('分发统计正常', stats.dispatched >= 1 && stats.failed === 0, stats)

  // ---- 反证:把从机也设成 master 会不会炸?(角色错配的鲁棒性)
  instances.list().forEach(i => i.setRole('master', { hover: false }))
  await sleep(400)
  const before = (await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__hits.length')))).reduce((a, b) => a + b, 0)
  const m2 = instances.list()[0]
  m2.webContents.sendInputEvent({ type: 'mouseMove', x: vx, y: vy })
  m2.webContents.sendInputEvent({ type: 'mouseDown', x: vx, y: vy, button: 'left', clickCount: 1 })
  m2.webContents.sendInputEvent({ type: 'mouseUp', x: vx, y: vy, button: 'left', clickCount: 1 })
  await sleep(2000)
  const after = (await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__hits.length')))).reduce((a, b) => a + b, 0)
  // 即使所有实例都误设成 master,主进程的来源校验和静默窗口也必须把风暴挡住
  check('全员误设为 master 也不会事件风暴', after - before <= N + 2, { 新增点击: after - before, 上限: N + 2 })

  // ---- 预热 + 开火
  instances.list().forEach(i => i.setRole(i.id === master.id ? 'master' : 'slave', { hover: false }))
  await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__hits.length=0')))
  const descriptor = await master.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('buy-now'); const r = el.getBoundingClientRect()
    return require === undefined ? null : null
  })()`).catch(() => null)
  // descriptor 直接构造(等价于 Locator.describe 的产物)
  const d = { tag: 'button', id: 'buy-now', testAttr: { attr: 'data-testid', value: 'buy-now' },
              text: '立即抢购', role: 'button', classes: ['buy'], path: '#buy-now',
              offset: { x: 0.5, y: 0.5 }, size: { w: 140, h: 48 } }
  const primed = await sync.prime('t1', d)
  check('预热成功', primed.every(p => p.ok), { primed: primed.map(p => ({ id: p.instanceId, ok: p.ok, reason: p.reason })) })

  const fired = await sync.fire('t1')
  check('开火命中所有从机', fired.ok === fired.total && fired.total === N - 1, { ok: fired.ok, total: fired.total })
  check('开火延迟在毫秒级', fired.latencyMs < 200, { latencyMs: fired.latencyMs })
  await sleep(700)
  const fireHits = await Promise.all(slaves.map(i => i.webContents.executeJavaScript('window.__hits')))
  check('开火确实点中了目标按钮', fireHits.every(h => h.some(x => x.what === 'buy-now')),
    { hits: fireHits.map(h => h.map(x => x.what)) })

  // ---- 浮层遮挡:中控台弹窗打开时必须把实例 view 收起来,否则弹窗会被原生画面整块盖住
  {
    const before = instances.list().map(i => ({ ...i.bounds }))
    // 模拟中控台上报"全部不可见"(openOverlay 里做的事)
    instances.applyRects(instances.list().map(i => ({ id: i.id, x: 0, y: 0, w: 0, h: 0, visible: false })))
    await sleep(400)
    const hidden = instances.list().map(i => i.view && i.view.getVisible())
    check('浮层打开时所有实例 view 被收起', hidden.every(v => v === false), { visible: hidden })

    // 收起来不等于掉线:隐藏期间照样能点中(实测 #6),这是"实例不会因为开弹窗而失效"的保证
    await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__hits.length=0')))
    const r2 = await master.webContents.executeJavaScript(
      `(()=>{const r=document.getElementById('buy-now').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    const z2 = master.actualZoomFactor()
    const hx = Math.round(r2.x * z2), hy = Math.round(r2.y * z2)
    master.webContents.sendInputEvent({ type: 'mouseMove', x: hx, y: hy })
    master.webContents.sendInputEvent({ type: 'mouseDown', x: hx, y: hy, button: 'left', clickCount: 1 })
    master.webContents.sendInputEvent({ type: 'mouseUp', x: hx, y: hy, button: 'left', clickCount: 1 })
    await sleep(1400)
    const hiddenHits = await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__hits')))
    check('view 收起期间主从同步照常工作(实例没掉线)',
      hiddenHits.slice(1).every(h => h.some(x => x.what === 'buy-now')),
      { 各从机: hiddenHits.slice(1).map(h => h.map(x => x.what)) })

    // 关闭浮层后必须原样放回来
    instances.applyRects(instances.list().map((i, idx) => ({
      id: i.id, x: before[idx].x, y: before[idx].y, w: before[idx].w, h: before[idx].h, visible: true,
    })))
    await sleep(400)
    const restored = instances.list().map((i, idx) =>
      i.view.getVisible() && i.view.getBounds().width === before[idx].w && i.view.getBounds().height === before[idx].h)
    check('浮层关闭后 view 原样放回', restored.every(Boolean),
      { bounds: instances.list().map(i => i.view.getBounds().width + 'x' + i.view.getBounds().height) })
  }

  const failed = results.filter(r => !r.pass)
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`)
  server.close()
  app.exit(failed.length ? 1 : 0)
}).catch(e => { console.error('E2E FATAL', e && e.stack || e); app.exit(1) })
