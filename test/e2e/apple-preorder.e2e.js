'use strict'
/**
 * iPhone 18 Pro Max 首发预购链路验证(跑真实 apple.com.cn)。
 *
 * 明晚 8 点才开售,但**不用等到那时候**也能把整条链路验证完:
 * 配置照常做(实测开售前所有选项就能选),然后往页面里手动插一个 add-to-cart 按钮,
 * 看守株待兔的观察器是不是真的立刻扑上去并点中 —— 这一步模拟的正是 20:00 那一刻按钮出现的瞬间。
 *
 * ⚠️ 全程不加购、不下单、不登录:配置页上的选择和任何一个逛店的人做的事一样。
 * 跑法:npm run test:e2e:preorder
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const { Logger } = require('../../src/main/core/Logger.js')
const { Clock } = require('../../src/main/core/Clock.js')
const { SessionFactory } = require('../../src/main/core/SessionFactory.js')
const { GuestRpc } = require('../../src/main/core/GuestRpc.js')
const { SyncEngine } = require('../../src/main/core/SyncEngine.js')
const { InstanceManager } = require('../../src/main/core/InstanceManager.js')
const { PlaybookRunner } = require('../../src/main/core/PlaybookRunner.js')
const { GUEST } = require('../../src/shared/ipc.js')
const preset = require('../../src/shared/presets/apple-cn.js')

const N = 3
const OUT = process.env.APPLEGO_E2E_OUT || null
function say(line) { console.log(line); if (OUT) { try { fs.appendFileSync(OUT, line + '\n') } catch (e) {} } }
const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
function check(name, cond, detail) {
  results.push({ name, pass: !!cond })
  say(`${cond ? '  ✔' : '  ✖'} ${name}${detail !== undefined ? '   ' + JSON.stringify(detail) : ''}`)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 940, show: true, backgroundColor: '#7A92A0' })
  const logger = new Logger({ level: 'warn' })
  const clock = new Clock()
  const sessionFactory = new SessionFactory({ dataDir: path.join(app.getPath('temp'), 'applego-preorder-e2e'), logger, clock })
  const rpc = new GuestRpc({ logger })
  const instances = new InstanceManager({ window: win, sessionFactory, logger, store: null, onChange: () => {} })
  const playbooks = new PlaybookRunner({ rpc, logger, clock })
  const sync = new SyncEngine({
    rpc, logger,
    getInstances: () => instances.list().map(i => ({
      id: i.id, enabled: i.enabled, boundsW: i.bounds.w,
      zoomFactor: i.actualZoomFactor(), actualZoomFactor: () => i.actualZoomFactor(),
      webContents: i.webContents,
    })).filter(i => i.webContents),
  })

  ipcMain.on(GUEST.ready, e => instances.onGuestReady(e.sender, null, { hover: false }))
  ipcMain.on(GUEST.trigger, (e, payload) => {
    const inst = instances.byWebContents(e.sender)
    if (!inst || !payload) return
    sync.handleTrigger({
      id: inst.id, webContents: inst.webContents, boundsW: inst.bounds.w,
      zoomFactor: inst.actualZoomFactor(), actualZoomFactor: () => inst.actualZoomFactor(),
    }, payload)
  })

  say(`· 创建 ${N} 个实例…`)
  await instances.create({ count: N, profile: preset.profileDefaults })
  const cellW = 495, cellH = 880
  instances.list().forEach((inst, i) => inst.applyBounds({ x: i * (cellW + 6), y: 0, w: cellW, h: cellH }, true))
  win.focus()
  say('· 实例就绪')

  const plan = preset.preorderPlan({ screensize: '6_9inch', color: 'black', capacity: '256gb' })
  say(`· 预购时刻 ${plan.preorderAt}(北京时间 ${new Date(plan.preorderAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})`)
  say(`· 剧本 "${plan.playbook.name}" 共 ${plan.playbook.steps.length} 步(停在加购之前)`)

  say('· 跑配置剧本…')
  const run = await playbooks.run(plan.playbook, instances.list(), {})
  check('18 Pro Max 配置剧本在所有实例上跑通', run.ok === run.total,
    { ok: run.ok, total: run.total, 耗时: run.elapsedMs + 'ms',
      失败: run.results.filter(r => !r.ok).map(r => ({ id: r.instanceId, step: (r.failedAt ?? 0) + 1, op: r.step, reason: r.reason })) })

  await sleep(1500)
  const v = await Promise.all(instances.list().map(inst => inst.webContents.executeJavaScript(`(() => {
    const q = s => document.querySelector(s)
    return {
      title: document.title,
      path: location.pathname,
      isMax: !!(q('[data-autom="dimensionScreensize6_9inch"]') || {}).checked,
      color: !!(q('[data-autom="dimensionColorblack"]') || {}).checked,
      cap:   !!(q('[data-autom="dimensionCapacity256gb"]') || {}).checked,
      noTi:  !!(q('[data-autom="choose-noTradeIn"]') || {}).checked,
      noAc:  !!(q('[data-autom="noapplecare"]') || {}).checked,
      addToCart: !!q('[data-autom="add-to-cart"]'),
      continueBtn: q('[data-autom="continueButton"]') ? (q('[data-autom="continueButton"]').innerText || '').trim() : null,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  })()`).catch(e => ({ error: String(e) }))))

  check('选中的是 Pro Max(6.9 吋)而不是 Pro', v.every(x => x.isMax), { isMax: v.map(x => x.isMax) })
  check('页面标题确认为 Pro Max', v.every(x => /Pro Max/.test(x.title)), { title: v.map(x => (x.title || '').slice(0, 34)) })
  check('颜色/容量/不换购/不要 AppleCare 全部选中',
    v.every(x => x.color && x.cap && x.noTi && x.noAc),
    { 明细: v.map(x => [x.color, x.cap, x.noTi, x.noAc]) })
  check('URL 带上了零件号(可直达)', v.every(x => /\/[a-z0-9]{5,8}\/a\/?$/i.test(x.path)), { path: v.map(x => x.path) })
  check('时区为 Asia/Shanghai', v.every(x => x.tz === 'Asia/Shanghai'))
  // 开售前后页面状态不同,用例要能同时覆盖两个阶段,而不是写死其中一个:
  //   开售前:只有 continueButton(「继续」),没有 add-to-cart  -> 用守株待兔
  //   开售后:continueButton 消失,add-to-cart(「添加到购物袋」)出现 -> 直接点
  const LIVE = v.every(x => x.addToCart)
  const PRE = v.every(x => !x.addToCart && x.continueBtn)
  check(LIVE ? '【已开售】加购按钮已出现,可直接点' : '【未开售】加购按钮尚不存在,只有「继续」',
    LIVE || PRE, { addToCart: v.map(x => x.addToCart), continueBtn: v.map(x => x.continueBtn) })
  say(LIVE ? '     >>> 目标已开售:实战应走「立即加入购物袋」,守株待兔用不上了'
           : '     >>> 目标未开售:实战应走「首发预购:配好并守株待兔」')
  say('     零件号: ' + v.map(x => (x.path.match(/\/([a-z0-9]{5,8})\/a\/?$/i) || [])[1] || '?').join(' | '))

  // ---- 守株待兔:布防
  const targets = instances.list().map(i => ({
    id: i.id, webContents: i.webContents, boundsW: i.bounds.w,
    zoomFactor: i.actualZoomFactor(), actualZoomFactor: () => i.actualZoomFactor(),
  }))
  // ⚠️ 已开售时按钮是真的、点下去会真的加购。用例不该在别人的线上商店留下副作用,
  //    所以这种情况下只布防、不自动开火(autoFire: false):只验证"能立刻发现按钮",不去点它。
  //    未开售时页面上没有真按钮,后面插的是我们自己造的假按钮,点它没有任何外部影响。
  const armed = await sync.armPounce(plan.pounce.key, plan.pounce.descriptor, targets,
    { ttlMs: 120000, autoFire: !LIVE })
  check('守株待兔在所有实例上布防成功', armed.every(a => a.ok), { armed: armed.map(a => ({ id: a.instanceId, ok: a.ok, immediate: a.immediate })) })
  // 已开售时按钮本来就在,布防应当**立刻命中**;未开售时则应当静静等着
  check(LIVE ? '已开售:布防时立刻命中既有按钮' : '未开售:布防时不误触发',
    LIVE ? armed.every(a => a.immediate) : armed.every(a => !a.immediate),
    { immediate: armed.map(a => a.immediate) })

  await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('window.__pounced=[];document.addEventListener("click",e=>{const a=e.target&&e.target.getAttribute&&e.target.getAttribute("data-autom");if(a==="add-to-cart")window.__pounced.push({trusted:e.isTrusted,at:Date.now()})},true)')))

  // ---- 模拟开售那一刻:按钮出现。
  // 已开售时页面上已经有真按钮了,再插一个会造成两个同名元素 -> Locator 会正确地判为歧义,
  // 那验证的就不是"扑得准"而是"挡得住歧义"了。所以这段只在未开售时跑。
  if (LIVE) {
    say('· 目标已开售,跳过"模拟按钮出现"(页面上已有真按钮,再插会制造歧义)')
    const st = sync.pounceStatus(plan.pounce.key)
    check('已开售路径:守株在布防瞬间就发现了按钮(只发现,不点,避免真的加购)',
      st && st.hits.length === N, { hits: st && st.hits.length })
    const failed0 = results.filter(r => !r.pass)
    say(`\n  ${results.length - failed0.length}/${results.length} 通过`)
    app.exit(failed0.length ? 1 : 0)
    return
  }

  say('· 模拟开售:往页面里插入 add-to-cart 按钮…')
  const t0 = Date.now()
  await Promise.all(instances.list().map(i => i.webContents.executeJavaScript(`(() => {
    const b = document.createElement('button')
    b.setAttribute('data-autom', 'add-to-cart')
    b.textContent = '添加到购物袋'
    b.className = 'button button-block'
    b.style.cssText = 'position:fixed;left:40px;bottom:80px;z-index:99999;padding:16px 40px;font-size:18px'
    b.addEventListener('click', () => { window.__realClick = true })
    document.body.appendChild(b)
    return true
  })()`)))

  await sleep(2000)
  const pounced = await Promise.all(instances.list().map(i => i.webContents.executeJavaScript('({hits:window.__pounced||[],real:!!window.__realClick})')))
  const elapsed = Date.now() - t0
  check('按钮一出现就被扑中(所有实例)', pounced.every(p => p.hits.length > 0 && p.real),
    { 各实例: pounced.map(p => p.hits.length), 全部耗时: elapsed + 'ms' })
  check('扑上去的是可信输入事件', pounced.every(p => p.hits.every(h => h.trusted)))

  const status = sync.pounceStatus(plan.pounce.key)
  const waits = (status.hits || []).map(h => h.waitedMs).filter(x => x != null)
  check('守株记录完整', status && status.hits.length === N, { hits: status && status.hits.length })
  if (waits.length) say('     从布防到命中各实例等待: ' + waits.map(w => w + 'ms').join(' | '))

  const failed = results.filter(r => !r.pass)
  say(`\n  ${results.length - failed.length}/${results.length} 通过`)
  app.exit(failed.length ? 1 : 0)
}).catch(e => { say('E2E FATAL ' + (e && e.stack || e)); app.exit(1) })
