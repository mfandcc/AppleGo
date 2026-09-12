'use strict'
/**
 * 把 build/icon.svg 渲染成 build/icon.png(1024×1024)。
 *
 * 用 Electron 自己的 Chromium 渲染,不引任何图形库依赖 ——
 * electron-builder 拿到一张 >=512 的 PNG 就能自动生成 macOS 的 .icns 和 Windows 的 .ico。
 *
 * 跑法:npm run icon
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const SIZE = 1024
const svgPath = path.join(__dirname, 'icon.svg')
const outPath = path.join(__dirname, 'icon.png')

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, 'utf8')
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false,
    // 透明底,圆角外面不要留黑边
    transparent: true, frame: false, backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  })
  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
    svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise(r => setTimeout(r, 500))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  fs.writeFileSync(outPath, img.toPNG())
  const { width, height } = img.getSize()
  console.log(`已生成 ${outPath} (${width}×${height}, ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`)
  app.exit(0)
}).catch(e => { console.error(e); app.exit(1) })
