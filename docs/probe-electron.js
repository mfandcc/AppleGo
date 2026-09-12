const { app, BrowserWindow, WebContentsView, session } = require('electron')
const http = require('http')

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;height:100%;font:14px system-ui}
#pad{position:absolute;left:50px;top:80px;width:120px;height:40px;background:#39f;color:#fff;display:flex;align-items:center;justify-content:center}
#txt{position:absolute;left:50px;top:150px}
</style></head><body>
<div id="pad">TARGET</div><input id="txt"><div style="height:3000px"></div>
<script>
window.__log=[]
function rec(e){__log.push({t:e.type,x:e.clientX,y:e.clientY,trusted:e.isTrusted,btn:e.button,cc:e.detail,tgt:(e.target&&e.target.id)||e.target.tagName})}
for(const t of ['mousedown','mouseup','click','dblclick','contextmenu']) document.addEventListener(t,rec,true)
document.addEventListener('wheel',e=>__log.push({t:'wheel',dy:e.deltaY,trusted:e.isTrusted,mode:e.deltaMode}),{capture:true,passive:true})
document.addEventListener('keydown',e=>__log.push({t:'keydown',key:e.key,code:e.code,trusted:e.isTrusted}),true)
document.addEventListener('input',e=>__log.push({t:'input',val:e.target.value,trusted:e.isTrusted}),true)
window.__probe=function(){return {log:__log,rect:document.getElementById('pad').getBoundingClientRect().toJSON(),
  dpr:devicePixelRatio,inner:[innerWidth,innerHeight],lang:navigator.language,
  tz:Intl.DateTimeFormat().resolvedOptions().timeZone,ls:localStorage.getItem('k'),origin:location.origin+location.search}}
window.__mark=function(){localStorage.setItem('k','set-by-'+location.search);return localStorage.getItem('k')}
</script></body></html>`

const out = {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(PAGE)
})

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const BASE = `http://127.0.0.1:${server.address().port}/`
  out.base = BASE

  const win = new BrowserWindow({ width: 900, height: 600, show: true })
  const sA = session.fromPartition('persist:probeA' + process.pid)
  const sB = session.fromPartition('persist:probeB' + process.pid)

  const mk = (ses) => { const v = new WebContentsView({ webPreferences: { session: ses } }); win.contentView.addChildView(v); return v }
  const vA = mk(sA), vB = mk(sB)
  vA.setBounds({ x: 0,   y: 0,  width: 440, height: 560 })
  vB.setBounds({ x: 450, y: 40, width: 440, height: 520 })   // 故意不同原点

  await Promise.all([vA.webContents.loadURL(BASE + '?A'), vB.webContents.loadURL(BASE + '?B')])
  win.focus(); win.moveTop(); await sleep(500)

  out.viewportA = await vA.webContents.executeJavaScript('[innerWidth,innerHeight,devicePixelRatio]')
  out.viewportB = await vB.webContents.executeJavaScript('[innerWidth,innerHeight,devicePixelRatio]')
  out.padRectA  = await vA.webContents.executeJavaScript('document.getElementById("pad").getBoundingClientRect().toJSON()')

  const P = { x: 110, y: 100 }   // pad 中心的页面 CSS 坐标
  const click = (v, x, y, cc = 1) => {
    v.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    v.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: cc })
    v.webContents.sendInputEvent({ type: 'mouseUp',   x, y, button: 'left', clickCount: cc })
  }
  // 1&2: 同一页面坐标打两个不同原点的 view
  click(vA, P.x, P.y); click(vB, P.x, P.y); await sleep(300)
  out.E1_A_hit = await vA.webContents.executeJavaScript('__log.filter(e=>e.t==="click").map(e=>[e.tgt,e.x,e.y,e.trusted])')
  out.E2_B_hit = await vB.webContents.executeJavaScript('__log.filter(e=>e.t==="click").map(e=>[e.tgt,e.x,e.y,e.trusted])')

  // 3: 双击
  await vA.webContents.executeJavaScript('__log.length=0')
  click(vA, P.x, P.y, 1); click(vA, P.x, P.y, 2); await sleep(300)
  out.E3_dblclick = await vA.webContents.executeJavaScript('__log.map(e=>e.t+":"+e.cc)')

  // 4: 滚轮 canScroll
  vA.webContents.sendInputEvent({ type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY: -120 })
  await sleep(250); out.E4_scroll_noCanScroll = await vA.webContents.executeJavaScript('window.scrollY')
  vA.webContents.sendInputEvent({ type: 'mouseWheel', x: 200, y: 300, deltaX: 0, deltaY: -120, canScroll: true })
  await sleep(250); out.E4_scroll_canScroll = await vA.webContents.executeJavaScript('window.scrollY')
  await vA.webContents.executeJavaScript('window.scrollTo(0,0)')

  // 5: 键盘
  await vA.webContents.executeJavaScript('document.getElementById("txt").focus();__log.length=0')
  for (const ch of ['h', 'i']) {
    vA.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    vA.webContents.sendInputEvent({ type: 'char',    keyCode: ch })
    vA.webContents.sendInputEvent({ type: 'keyUp',   keyCode: ch })
  }
  for (const k of ['A']) {
    vA.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['shift'] })
    vA.webContents.sendInputEvent({ type: 'char',    keyCode: k, modifiers: ['shift'] })
    vA.webContents.sendInputEvent({ type: 'keyUp',   keyCode: k, modifiers: ['shift'] })
  }
  await sleep(300)
  out.E5_typedValue = await vA.webContents.executeJavaScript('document.getElementById("txt").value')
  out.E5_keyLog = await vA.webContents.executeJavaScript('__log.filter(e=>e.t==="keydown").map(e=>[e.key,e.code,e.trusted])')

  // 6: 隐藏 view 还能否收输入
  vB.setVisible(false); await sleep(200)
  await vB.webContents.executeJavaScript('__log.length=0')
  click(vB, P.x, P.y); await sleep(350)
  out.E6_hiddenViewClicks = await vB.webContents.executeJavaScript('__log.filter(e=>e.t==="click").map(e=>[e.tgt,e.x,e.y])')
  out.E6_hiddenRect = await vB.webContents.executeJavaScript('document.getElementById("pad").getBoundingClientRect().toJSON()')
  vB.setVisible(true)

  // 7: session 隔离
  out.E7_markA = await vA.webContents.executeJavaScript('__mark()')
  out.E7_B_seesA = await vB.webContents.executeJavaScript('localStorage.getItem("k")')
  const vC = mk(sA); vC.setBounds({ x: 0, y: 0, width: 300, height: 300 }); vC.setVisible(false)
  await vC.webContents.loadURL(BASE + '?C')
  out.E7_C_sharesA = await vC.webContents.executeJavaScript('localStorage.getItem("k")')

  // 8: CDP 时区/语言
  try {
    const d = vC.webContents.debugger; d.attach('1.3')
    await d.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' })
    await d.sendCommand('Emulation.setLocaleOverride', { locale: 'ja-JP' })
    out.E8_tz = await vC.webContents.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone')
    out.E8_locale = await vC.webContents.executeJavaScript('new Intl.NumberFormat().resolvedOptions().locale')
    out.E8_baseline_tz = await vA.webContents.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone')
    d.detach()
  } catch (e) { out.E8_error = String(e) }

  // 9: zoomFactor 与坐标系
  try {
    const vZ = mk(sA); vZ.setBounds({ x: 450, y: 40, width: 440, height: 520 })
    await vZ.webContents.loadURL(BASE + '?Z')
    vZ.webContents.setZoomFactor(0.5); await sleep(450)
    out.E9_inner = await vZ.webContents.executeJavaScript('[innerWidth,innerHeight,devicePixelRatio]')
    await vZ.webContents.executeJavaScript('__log.length=0')
    click(vZ, 110, 100)   // 页面 CSS 坐标
    await sleep(250)
    out.E9_hit_cssCoords = await vZ.webContents.executeJavaScript('__log.filter(e=>e.t==="click").map(e=>[e.tgt,e.x,e.y])')
    await vZ.webContents.executeJavaScript('__log.length=0')
    click(vZ, 55, 50)     // view 物理坐标 = CSS*zoom
    await sleep(250)
    out.E9_hit_viewCoords = await vZ.webContents.executeJavaScript('__log.filter(e=>e.t==="click").map(e=>[e.tgt,e.x,e.y])')
  } catch (e) { out.E9_error = String(e) }

  // 10: 窗口失焦后 sendInputEvent 是否生效
  try {
    await vA.webContents.executeJavaScript('__log.length=0')
    win.blur(); await sleep(400)
    click(vA, P.x, P.y); await sleep(400)
    out.E10_blurred_clicks = await vA.webContents.executeJavaScript('__log.filter(e=>e.t==="click").length')
    win.focus(); await sleep(300)
    await vA.webContents.executeJavaScript('__log.length=0')
    click(vA, P.x, P.y); await sleep(300)
    out.E10_refocused_clicks = await vA.webContents.executeJavaScript('__log.filter(e=>e.t==="click").length')
  } catch (e) { out.E10_error = String(e) }

  // 11: 延迟 — 20 次 sendInputEvent + executeJavaScript 往返耗时
  try {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < 50; i++) vA.webContents.sendInputEvent({ type: 'mouseMove', x: 10 + i, y: 10 })
    out.E11_send50_us = Number(process.hrtime.bigint() - t0) / 1000
    const t1 = process.hrtime.bigint()
    await vA.webContents.executeJavaScript('1+1')
    out.E11_execJS_roundtrip_us = Number(process.hrtime.bigint() - t1) / 1000
  } catch (e) { out.E11_error = String(e) }

  console.log('===PROBE_RESULT_BEGIN===')
  console.log(JSON.stringify(out, null, 2))
  console.log('===PROBE_RESULT_END===')
  server.close(); app.exit(0)
}).catch(e => { console.log('FATAL', e && e.stack || e); app.exit(1) })
