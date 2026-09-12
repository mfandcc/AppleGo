const { app, BrowserWindow, WebContentsView, session } = require('electron')
const http = require('http')
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="pad" style="position:absolute;left:50px;top:80px;width:120px;height:40px;background:#39f"></div>
<div style="height:4000px"></div>
<script>window.__w=[];addEventListener('wheel',e=>__w.push({dy:e.deltaY,mode:e.deltaMode}),{passive:true,capture:true})</script>
</body></html>`
const out = {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
app.whenReady().then(async () => {
  const srv = http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});r.end(PAGE)})
  await new Promise(r=>srv.listen(0,'127.0.0.1',r))
  const BASE = `http://127.0.0.1:${srv.address().port}/`
  const win = new BrowserWindow({width:900,height:700,show:true})
  const ses = session.fromPartition('probe2-'+process.pid)
  const v = new WebContentsView({webPreferences:{session:ses}})
  win.contentView.addChildView(v); v.setBounds({x:0,y:0,width:600,height:600})
  await v.webContents.loadURL(BASE+'?1'); win.focus(); await sleep(400)

  // ---- A: CDP 时区覆盖能否挺过一次导航
  const d = v.webContents.debugger; d.attach('1.3')
  await d.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' })
  out.A_before = await v.webContents.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone')
  await v.webContents.loadURL(BASE+'?2')          // 同源导航
  await sleep(400)
  out.A_afterSameOrigin = await v.webContents.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone')
  await v.webContents.loadURL('https://example.com/')   // 跨源导航
  await sleep(1500)
  out.A_afterCrossOrigin = await v.webContents.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone').catch(e=>'ERR')
  out.A_stillAttached = d.isAttached()
  await v.webContents.loadURL(BASE+'?3'); await sleep(400)
  out.A_afterBack = await v.webContents.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone')

  // ---- D: zoom≠1 时 wheel 的 deltaY 会不会也被 zoom 换算
  v.webContents.setZoomFactor(0.5); await sleep(400)
  out.D_inner = await v.webContents.executeJavaScript('[innerWidth,innerHeight]')
  await v.webContents.executeJavaScript('window.scrollTo(0,0);__w.length=0')
  v.webContents.sendInputEvent({type:'mouseWheel',x:100,y:100,deltaX:0,deltaY:-240,canScroll:true})
  await sleep(300)
  out.D_pageDelta = await v.webContents.executeJavaScript('__w.map(e=>e.dy)')
  out.D_scrollY_zoom05 = await v.webContents.executeJavaScript('window.scrollY')
  v.webContents.setZoomFactor(1); await sleep(300)
  await v.webContents.executeJavaScript('window.scrollTo(0,0);__w.length=0')
  v.webContents.sendInputEvent({type:'mouseWheel',x:100,y:100,deltaX:0,deltaY:-240,canScroll:true})
  await sleep(300)
  out.D_pageDelta_zoom1 = await v.webContents.executeJavaScript('__w.map(e=>e.dy)')
  out.D_scrollY_zoom1 = await v.webContents.executeJavaScript('window.scrollY')

  // ---- C: zoomFactor 的真实下限
  for (const z of [0.5, 0.25, 0.2, 0.1]) {
    v.webContents.setZoomFactor(z); await sleep(250)
    out['C_set'+z] = { requested: z, actual: +v.webContents.getZoomFactor().toFixed(4),
                       inner: await v.webContents.executeJavaScript('innerWidth') }
  }

  // ---- B: closeAllConnections 是否存在且可调
  try { await ses.closeAllConnections(); out.B_closeAllConnections = 'ok' } catch(e){ out.B_closeAllConnections = String(e) }
  try { out.B_resolveProxy = await ses.resolveProxy('https://www.apple.com.cn/') } catch(e){ out.B_resolveProxy = String(e) }
  try { v.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); out.B_webrtc='ok' } catch(e){ out.B_webrtc=String(e) }

  console.log('===R===');console.log(JSON.stringify(out,null,2));console.log('===E===')
  srv.close(); app.exit(0)
}).catch(e=>{console.log('FATAL',e&&e.stack);app.exit(1)})
