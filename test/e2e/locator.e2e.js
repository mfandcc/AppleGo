'use strict'
/**
 * Locator 端到端验证:主机描述一个元素,从机在**布局已经明显不一样**的页面里把它找回来,
 * 再用真实 sendInputEvent 打过去,看是不是真的点中了。
 *
 * 跑法:npm run test:e2e
 * 这是整套主从同步的核心机制验证,不是单元测试的补充 —— 它验证的正是"坐标同步会点错、语义同步不会"。
 */
const { app, BrowserWindow, WebContentsView, session } = require('electron')
const http = require('http')
const path = require('path')

const LOCATOR_SRC = require('fs').readFileSync(path.join(__dirname, '../../src/shared/Locator.js'), 'utf8')

/** 商品页。variant 控制"从机和主机长得有多不一样" */
function page(variant) {
  const banner = variant === 'banner' || variant === 'all'
    ? '<div style="height:180px;background:#fee;padding:20px">🎁 新人专享大礼包(主机上没有这个)</div>' : ''
  const modal = variant === 'modal' || variant === 'all'
    ? '<div id="coupon" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9"><div style="background:#fff;margin:100px auto;width:300px;padding:20px">优惠券弹窗</div></div>' : ''
  const extraCard = variant === 'reorder' || variant === 'all'
    ? '<div class="card"><h3>推荐商品</h3><button class="buy-btn" data-testid="buy-recommend">立即抢购</button></div>' : ''
  const wide = variant === 'all' ? 'style="max-width:520px"' : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>shop</title><style>
    body{margin:0;font:14px system-ui}
    .card{border:1px solid #ddd;margin:16px;padding:16px}
    .buy-btn{padding:12px 28px;font-size:16px;background:#f40;color:#fff;border:0;border-radius:6px;cursor:pointer}
    .spacer{height:600px}
  </style></head><body ${wide}>
    ${banner}
    <div class="nav"><a href="/cart" id="cart-link">购物车</a></div>
    ${extraCard}
    <div class="card" id="product-main">
      <h3>限量球鞋 42 码</h3>
      <button class="buy-btn" data-testid="buy-now" id="buy-now-btn">立即抢购</button>
      <button class="buy-btn" data-testid="add-cart">加入购物车</button>
    </div>
    <div class="spacer"></div>
    <div class="card"><button class="buy-btn" data-testid="buy-below">立即抢购</button></div>
    ${modal}
    <script>window.__clicks=[];document.addEventListener('click',e=>{
      const t=e.target; window.__clicks.push({id:t.id||null,testid:t.getAttribute&&t.getAttribute('data-testid')||null,text:(t.innerText||'').trim(),trusted:e.isTrusted,x:e.clientX,y:e.clientY})
    },true)</script>
  </body></html>`
}

const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail })
  console.log(`${cond ? '  ✔' : '  ✖'} ${name}${detail ? '   ' + JSON.stringify(detail) : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const variant = (req.url.split('?')[1] || 'plain')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(page(variant))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const BASE = `http://127.0.0.1:${server.address().port}/?`

  const win = new BrowserWindow({ width: 1400, height: 900, show: true })
  const ses = session.fromPartition('e2e-locator-' + process.pid)
  const mk = () => { const v = new WebContentsView({ webPreferences: { session: ses } }); win.contentView.addChildView(v); return v }

  const master = mk(); master.setBounds({ x: 0, y: 0, width: 680, height: 880 })
  const slave  = mk(); slave.setBounds({ x: 690, y: 0, width: 680, height: 880 })

  await master.webContents.loadURL(BASE + 'plain')
  await slave.webContents.loadURL(BASE + 'all')      // 从机:多了 banner + 弹窗 + 重排的推荐卡片 + 更窄
  win.focus(); await sleep(500)

  const inject = wc => wc.executeJavaScript(LOCATOR_SRC + ';1', false)
  await inject(master.webContents); await inject(slave.webContents)

  // ---- 主机:描述"立即抢购"按钮(模拟用户点在按钮中心偏左的位置)
  const descriptor = await master.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('#product-main [data-testid="buy-now"]')
    const r = el.getBoundingClientRect()
    return AppleGoLocator.describe(el, { clientX: r.left + r.width*0.3, clientY: r.top + r.height*0.5 })
  })()`)
  check('主机能描述出目标元素', descriptor && descriptor.testAttr && descriptor.testAttr.value === 'buy-now', {
    id: descriptor && descriptor.id, testAttr: descriptor && descriptor.testAttr, text: descriptor && descriptor.text,
  })
  check('点击偏移被记录下来(不是硬点中心)', descriptor && Math.abs(descriptor.offset.x - 0.3) < 0.02, descriptor && descriptor.offset)

  // ---- 对照组:如果只同步坐标会发生什么
  const masterRect = await master.webContents.executeJavaScript(
    `(()=>{const r=document.querySelector('#product-main [data-testid="buy-now"]').getBoundingClientRect();return {x:r.left+r.width*0.3,y:r.top+r.height*0.5}})()`)
  await slave.webContents.executeJavaScript('window.__clicks.length=0')
  slave.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(masterRect.x), y: Math.round(masterRect.y) })
  slave.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(masterRect.x), y: Math.round(masterRect.y), button: 'left', clickCount: 1 })
  slave.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(masterRect.x), y: Math.round(masterRect.y), button: 'left', clickCount: 1 })
  await sleep(300)
  const coordClicks = await slave.webContents.executeJavaScript('window.__clicks')
  const coordHitRight = coordClicks.some(c => c.testid === 'buy-now')
  check('【对照】纯坐标同步在布局不同的从机上打偏了', !coordHitRight, { 实际点到: coordClicks.map(c => c.testid || c.text) })

  // ---- 语义同步:先把弹窗关掉(模拟"需人工"处理完),再解析
  await slave.webContents.executeJavaScript(`document.getElementById('coupon') && document.getElementById('coupon').remove()`)
  const resolved = await slave.webContents.executeJavaScript(
    `AppleGoLocator.resolve(${JSON.stringify(descriptor)}, document)` +
    `&&(r=>({ok:r.ok,reason:r.reason,strategy:r.strategy,confidence:r.confidence,candidates:r.candidates,cssX:r.cssX,cssY:r.cssY,actionable:r.actionable}))(AppleGoLocator.resolve(${JSON.stringify(descriptor)}, document))`)
  check('从机能解析出落点', resolved && resolved.ok, resolved)
  check('用的是高可靠策略(id/testAttr)', resolved && ['id', 'testAttr'].includes(resolved.strategy), { strategy: resolved && resolved.strategy })
  check('置信度足够高', resolved && resolved.confidence >= 0.3, { confidence: resolved && resolved.confidence })

  // ---- 用解析出的坐标注入,验证真的点中了
  await slave.webContents.executeJavaScript('window.__clicks.length=0')
  const zx = Math.round(resolved.cssX), zy = Math.round(resolved.cssY)   // zoomFactor = 1
  slave.webContents.sendInputEvent({ type: 'mouseMove', x: zx, y: zy })
  slave.webContents.sendInputEvent({ type: 'mouseDown', x: zx, y: zy, button: 'left', clickCount: 1 })
  slave.webContents.sendInputEvent({ type: 'mouseUp', x: zx, y: zy, button: 'left', clickCount: 1 })
  await sleep(300)
  const semClicks = await slave.webContents.executeJavaScript('window.__clicks')
  check('语义同步点中了正确的按钮', semClicks.some(c => c.testid === 'buy-now'), { 实际点到: semClicks.map(c => c.testid || c.text) })
  check('注入事件是可信事件 isTrusted=true', semClicks.length > 0 && semClicks.every(c => c.trusted))

  // ---- 歧义处理:三个按钮文字都叫"立即抢购",只靠文字必须判为不可信
  const textOnly = { tag: 'button', text: '立即抢购', role: 'button', size: { w: 120, h: 44 }, offset: { x: 0.5, y: 0.5 } }
  const ambiguous = await slave.webContents.executeJavaScript(
    `(r=>({ok:r.ok,reason:r.reason,strategy:r.strategy,candidates:r.candidates}))(AppleGoLocator.resolve(${JSON.stringify(textOnly)}, document))`)
  check('同名按钮有多个时,不瞎点而是报歧义', !ambiguous.ok && ambiguous.reason === 'ambiguous', ambiguous)

  // ---- 视口外的元素要先滚进来
  const belowDesc = await master.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-testid="buy-below"]'); const r = el.getBoundingClientRect()
    return AppleGoLocator.describe(el, { clientX: r.left + r.width/2, clientY: r.top + r.height/2 })
  })()`)
  await slave.webContents.executeJavaScript('window.scrollTo(0,0); window.__clicks.length=0')
  const scrolled = await slave.webContents.executeJavaScript(
    `(r=>({ok:r.ok,reason:r.reason,strategy:r.strategy,cssX:r.cssX,cssY:r.cssY}))(AppleGoLocator.resolve(${JSON.stringify(belowDesc)}, document))`)
  check('视口外的元素会被自动滚进来并给出可用坐标', scrolled.ok && scrolled.cssY >= 0 && scrolled.cssY <= 880, scrolled)
  if (scrolled.ok) {
    const sx = Math.round(scrolled.cssX), sy = Math.round(scrolled.cssY)
    slave.webContents.sendInputEvent({ type: 'mouseMove', x: sx, y: sy })
    slave.webContents.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1 })
    slave.webContents.sendInputEvent({ type: 'mouseUp', x: sx, y: sy, button: 'left', clickCount: 1 })
    await sleep(300)
    const c = await slave.webContents.executeJavaScript('window.__clicks')
    check('滚动后点中了视口外那个按钮', c.some(x => x.testid === 'buy-below'), { 实际点到: c.map(x => x.testid) })
  }

  // ---- 找不到的元素必须老实说找不到
  const missing = await slave.webContents.executeJavaScript(
    `(r=>({ok:r.ok,reason:r.reason}))(AppleGoLocator.resolve(${JSON.stringify({ tag: 'button', id: 'does-not-exist', text: 'ZZZ不存在ZZZ' })}, document))`)
  check('不存在的元素报 not-found 而不是乱点', !missing.ok, missing)

  // ---- zoomFactor 下的坐标换算必须一致
  slave.webContents.setZoomFactor(0.5); await sleep(400)
  await slave.webContents.executeJavaScript('window.__clicks.length=0')
  const zoomed = await slave.webContents.executeJavaScript(
    `(r=>({ok:r.ok,cssX:r.cssX,cssY:r.cssY}))(AppleGoLocator.resolve(${JSON.stringify(descriptor)}, document))`)
  const { toViewCoords } = require('../../src/main/core/InputCodec.js')
  const vp = toViewCoords(zoomed.cssX, zoomed.cssY, 0.5)
  slave.webContents.sendInputEvent({ type: 'mouseMove', x: vp.x, y: vp.y })
  slave.webContents.sendInputEvent({ type: 'mouseDown', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
  slave.webContents.sendInputEvent({ type: 'mouseUp', x: vp.x, y: vp.y, button: 'left', clickCount: 1 })
  await sleep(300)
  const zClicks = await slave.webContents.executeJavaScript('window.__clicks')
  check('zoom=0.5 时经 InputCodec 换算后依然点中', zClicks.some(c => c.testid === 'buy-now'),
    { cssX: zoomed.cssX, cssY: zoomed.cssY, viewX: vp.x, viewY: vp.y, 实际点到: zClicks.map(c => c.testid) })

  const failed = results.filter(r => !r.pass)
  console.log(`\n  ${results.length - failed.length}/${results.length} 通过`)
  server.close()
  app.exit(failed.length ? 1 : 0)
}).catch(e => { console.error('E2E FATAL', e && e.stack || e); app.exit(1) })
