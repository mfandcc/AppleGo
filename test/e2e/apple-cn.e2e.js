'use strict'
/**
 * Apple 中国大陆官网实站验证。
 *
 * 跑真实的 www.apple.com.cn 配置页,验证 presets/apple-cn.js 里的 data-autom 选择器
 * 在实站上确实能定位到、确实能点中。
 *
 * ⚠️ 这个用例**故意停在"加入购物袋"之前**:只做配置页上的选择(和任何一个逛店的人做的事一样),
 * 不加购、不下单、不登录。需要联网。
 *
 * 跑法:npm run test:e2e:apple
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

const { Logger } = require('../../src/main/core/Logger.js')
const { Clock } = require('../../src/main/core/Clock.js')
const { SessionFactory } = require('../../src/main/core/SessionFactory.js')
const { GuestRpc } = require('../../src/main/core/GuestRpc.js')
const { InstanceManager } = require('../../src/main/core/InstanceManager.js')
const { PlaybookRunner } = require('../../src/main/core/PlaybookRunner.js')
const { GUEST } = require('../../src/shared/ipc.js')
const preset = require('../../src/shared/presets/apple-cn.js')

const N = 3
const MODEL = 'iphone-17'
const COLOR = 'black'
const CAP = '256gb'

const fs = require('fs')
const OUT = process.env.APPLEGO_E2E_OUT || null

/**
 * 同步写盘再 console.log。
 * Electron 主进程的 stdout 重定向到文件时是块缓冲的,进程不退出就一个字都看不到 ——
 * 跑实站用例时那等于全程瞎跑。写盘这一步保证进度实时可见。
 */
function say(line) {
  console.log(line)
  if (OUT) { try { fs.appendFileSync(OUT, line + '\n') } catch (e) { /* ignore */ } }
}

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
  const sessionFactory = new SessionFactory({ dataDir: path.join(app.getPath('temp'), 'applego-apple-e2e'), logger, clock })
  const rpc = new GuestRpc({ logger })
  const instances = new InstanceManager({ window: win, sessionFactory, logger, store: null, onChange: () => {} })
  const playbooks = new PlaybookRunner({ rpc, logger, clock })

  ipcMain.on(GUEST.ready, e => instances.onGuestReady(e.sender, null, { hover: false }))
  ipcMain.on(GUEST.state, (e, p) => instances.onGuestState(e.sender, p))

  say('· 创建 ' + N + ' 个实例…')
  await instances.create({ count: N, profile: preset.profileDefaults })
  say('· 实例就绪')
  const cellW = 495, cellH = 880
  instances.list().forEach((inst, i) => inst.applyBounds({ x: i * (cellW + 6), y: 0, w: cellW, h: cellH }, true))
  win.focus()

  // —— 时钟:用 Apple 自己的响应头 Date 对表
  say('· 开始对表…')
  const cs = await clock.syncWith(preset.clockSource, { samples: 8, totalTimeoutMs: 25000 }).catch(e => ({ error: String(e) }))
  check('能用 apple.com.cn 的响应头校准时钟',
    cs && cs.samples > 0 && Number.isFinite(cs.offsetMs),
    { 样本: cs && cs.samples, 偏移: cs && cs.offsetMs + 'ms', 不确定度: cs && ('±' + cs.uncertaintyMs + 'ms') })

  // —— 环境隔离:时区/语言是否按预设生效
  for (const inst of instances.list()) await sessionFactory.applyEmulation(inst.webContents, preset.profileDefaults)

  // —— 跑剧本,但停在"加入购物袋"之前
  const pb = preset.buyPlaybook({ model: MODEL, color: COLOR, capacity: CAP, appleCare: false, tradeIn: false })
  // 停在"添加到购物袋"之前:只做配置页上的选择,不加购、不下单
  const stopBeforeBag = { name: pb.name, steps: pb.steps.filter(s => s.label !== '加入购物袋') }
  say(`\n  剧本 "${stopBeforeBag.name}" 共 ${stopBeforeBag.steps.length} 步(已去掉加购)\n`)

  say('· 开始跑剧本…')
  const run = await playbooks.run(stopBeforeBag, instances.list(), {})
  say('· 剧本结束')
  check('剧本在所有实例上跑通', run.ok === run.total,
    { ok: run.ok, total: run.total, 耗时: run.elapsedMs + 'ms',
      失败: run.results.filter(r => !r.ok).map(r => ({ id: r.instanceId, step: (r.failedAt ?? 0) + 1, op: r.step, reason: r.reason })) })

  for (const r of run.results.filter(x => x.ok)) {
    const slow = r.trace.filter(t => t.ms > 1200).map(t => `${t.op}:${t.ms}ms`)
    if (slow.length) say(`     #${r.instanceId} 较慢的步骤: ${slow.join(', ')}`)
  }

  await sleep(1200)

  // —— 验证配置真的被选中了(而不是"点了但没生效")
  const verified = await Promise.all(instances.list().map(inst => inst.webContents.executeJavaScript(`(() => {
    const q = s => document.querySelector(s)
    const color = q('[data-autom="dimensionColor${COLOR}"]')
    const cap   = q('[data-autom="dimensionCapacity${CAP}"]')
    const noTi  = q('[data-autom="choose-noTradeIn"]')
    const noAc  = q('[data-autom="noapplecare"]')
    const cont  = q('[data-autom="add-to-cart"]') || q('[data-autom="continueButton"]')
    return {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: navigator.language,
      viewport: innerWidth,
      colorChecked: !!(color && color.checked),
      capChecked: !!(cap && cap.checked),
      noTradeInChecked: !!(noTi && noTi.checked),
      noAppleCareChecked: !!(noAc && noAc.checked),
      continueText: cont ? (cont.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 20) : null,
      price: (q('[data-autom="summaryPrice"]') || q('[data-autom="headerPrice"]') || {}).innerText
               ? (q('[data-autom="summaryPrice"]') || q('[data-autom="headerPrice"]')).innerText.replace(/\\s+/g,' ').trim().slice(0,40) : null,
    }
  })()`).catch(e => ({ error: String(e) }))))

  check('颜色确实被选中', verified.every(v => v.colorChecked), { 各实例: verified.map(v => v.colorChecked) })
  check('容量确实被选中', verified.every(v => v.capChecked), { 各实例: verified.map(v => v.capChecked) })
  check('「不换购」确实被选中', verified.every(v => v.noTradeInChecked), { 各实例: verified.map(v => v.noTradeInChecked) })
  check('「不要 AppleCare+」确实被选中', verified.every(v => v.noAppleCareChecked), { 各实例: verified.map(v => v.noAppleCareChecked) })
  check('「添加到购物袋」按钮已就绪', verified.every(v => v.continueText), { text: verified.map(v => v.continueText) })
  // 零件号只是个加速手段(下次可直达),Apple 并不保证立刻写进 URL,所以只报告不断言
  say('     零件号直达路径: ' + verified.map(v => v.partUrl || '(本次未出现)').join(' | '))
  check('时区已按预设覆盖为 Asia/Shanghai', verified.every(v => v.tz === 'Asia/Shanghai'), { 各实例: verified.map(v => v.tz) })
  check('语言已按预设覆盖为 zh-CN', verified.every(v => String(v.lang).startsWith('zh')), { 各实例: verified.map(v => v.lang) })
  check('统一逻辑视口生效(各实例布局可比)', new Set(verified.map(v => v.viewport)).size === 1, { viewport: verified.map(v => v.viewport) })
  say('     实时价格: ' + verified.map(v => v.price).join(' | '))

  // —— 各实例是独立环境(cookie 不共享)
  const cookieCounts = await Promise.all(instances.list().map(async inst => (await inst.session.cookies.get({ domain: '.apple.com.cn' })).length))
  const sessionIds = await Promise.all(instances.list().map(async inst => {
    const cs = await inst.session.cookies.get({ domain: '.apple.com.cn' })
    // dssid2 是 Apple 的会话标识;as_sfa 是静态的地区/语言串,拿它比对会误判
    const s = cs.find(c => c.name === 'dssid2') || cs.find(c => /^dssf?\d?$/i.test(c.name))
    return s ? s.name + '=' + String(s.value).slice(0, 12) : null
  }))
  check('各实例都拿到了自己的 Apple cookie', cookieCounts.every(n => n > 0), { 'cookie 数': cookieCounts })
  const distinct = new Set(sessionIds.filter(Boolean))
  check('各实例的会话 cookie 互不相同(环境确实独立)',
    sessionIds.filter(Boolean).length < 2 || distinct.size === sessionIds.filter(Boolean).length,
    { sessions: sessionIds })

  const failed = results.filter(r => !r.pass)
  say(`\n  ${results.length - failed.length}/${results.length} 通过`)
  app.exit(failed.length ? 1 : 0)
}).catch(e => { say('E2E FATAL ' + (e && e.stack || e)); app.exit(1) })
