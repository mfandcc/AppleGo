# Electron 44.3.0 API 事实清单(直接读 node_modules/electron/electron.d.ts 求证)

> 实现时以本文件为准。凡与之冲突的写法一律判错。

## 1. 视图模型

- `BrowserView` 仍在 `electron.d.ts` 中(4130 行),但**已废弃**,新代码一律用 `WebContentsView`。
- `class WebContentsView extends View`,构造签名:
  `new WebContentsView({ webPreferences?: WebPreferences, webContents?: WebContents })`
  - `webContents` 选项可"收养"一个已存在的 WebContents(同一时刻只能挂在一个 View 上)——做**标签页**时很有用:同一个实例的多个 Tab 各持一个 WebContents,切换时换 View。
  - 只读属性 `view.webContents`。
  - 事件:`'bounds-changed'`。
- `class View extends NodeEventEmitter` 提供:
  - `addChildView(view, index?)` / `removeChildView(view)` / 只读 `children: View[]`
  - `getBounds(): Rectangle` / `setBounds(bounds, options?)`
  - `getVisible(): boolean` / `setVisible(visible)`
  - `setBackgroundColor(color)`(注意 hex 带 alpha 是 `AARRGGBB`,不是 `RRGGBBAA`)
  - `setBorderRadius(radius)`(⚠️ 圆角切掉的区域**仍然接收点击**)
  - `setBackgroundBlur(blurRadius)`
- `BrowserWindow.contentView: View` —— 宿主窗口的根 View,`win.contentView.addChildView(v)` 挂载。
- `addChildView` 对已存在的子 View 再调一次 = **提到最顶层**(z 序控制手段)。

## 2. sendInputEvent(同步引擎的地基)

```ts
webContents.sendInputEvent(inputEvent: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void
```

- 官方注释原文:承载该 contents 的 BrowserWindow 必须处于 focused 状态,`sendInputEvent()` 才生效。
  → ⚠️ **实测(macOS/Electron 44)`win.blur()` 后仍然生效**,见 `docs/EMPIRICAL-PROBE.md` #10。不把它当保证:关键操作前仍 `stageWin.focus()` 兜底,但架构上不强制单窗口。
- 坐标 `x`/`y` 相对 **WebContentsView 自身左上角**(不是屏幕、不是宿主窗口)—— **已实测确认**(#1)。
  → 主从之间可直接复用页面坐标,**不需要**窗口偏移换算。
  → ⚠️ 但收的是 **view 物理坐标(DIP)**,不是页面 CSS 坐标:`viewX = cssX × zoomFactor`(实测 #9)。
- `MouseInputEvent`:
  - `type`: `mouseDown` | `mouseUp` | `mouseMove` | `mouseEnter` | `mouseLeave` | `contextMenu` | `mouseWheel`
  - `x`, `y`(必填),`button?`: `left`|`middle`|`right`,`clickCount?`: number(双击 = 第二次 down/up 带 `clickCount: 2`)
  - `globalX?`, `globalY?`, `movementX?`, `movementY?`
- `MouseWheelInputEvent extends MouseInputEvent`:
  - `type: 'mouseWheel'`,`deltaX?`, `deltaY?`, `canScroll?`
  - `wheelTicksX?`, `wheelTicksY?`, `hasPreciseScrollingDeltas?`, `accelerationRatioX/Y?`
  - ⚠️ 文档未说明 `canScroll` 默认值,**实测不带也会滚动**(见 `docs/EMPIRICAL-PROBE.md` #4),仍建议显式传 `true`
- `KeyboardInputEvent`:
  - `type`: `rawKeyDown` | `keyDown` | `keyUp` | `char`
  - `keyCode: string` —— 必须是合法的 **Accelerator key code**(如 `'a'`、`'Enter'`、`'Backspace'`、`'Tab'`)
  - 输入可见字符的正确序列:`keyDown` → `char` → `keyUp`
- `modifiers?: Array<'shift'|'control'|'ctrl'|'alt'|'meta'|'command'|'cmd'|'iskeypad'|'isautorepeat'|'leftbuttondown'|'middlebuttondown'|'rightbuttondown'|'capslock'|'numlock'|'left'|'right'>`
- 注入的事件在页面里 **`isTrusted === true`** —— **已实测确认**(#2),走 Chromium 输入管线而非 `dispatchEvent`。
  → 好处:站点的 `isTrusted` 校验能过。
  → 代价:**从机 preload 的捕获器会把注入事件当成用户事件重新上报 → 自激循环**。必须用"仅主机挂捕获器 + 注入静默窗口"双保险来断环(见架构文档)。

## 3. 独立环境(session 隔离)

- `session.fromPartition('persist:<id>')` —— 命名分区,持久化在 `userData/Partitions/<id>`。
- `session.fromPath(path, { cache: boolean })` —— **Electron 44 可用**,直接指定磁盘目录,做 profile 导入/导出/备份比 partition 干净。
- 绑定到视图:`new WebContentsView({ webPreferences: { session } })`(优先)或 `{ partition: 'persist:x' }`。
- 隔离边界:cookie / localStorage / sessionStorage / IndexedDB / Cache Storage / Service Worker / HTTP cache / 权限授予 全部按 session 分开。
- `ses.setProxy(config: ProxyConfig): Promise<void>`
  - `mode?: 'direct'|'auto_detect'|'pac_script'|'fixed_servers'|'system'`
  - `proxyRules?: string`(如 `http=1.2.3.4:8080;https=1.2.3.4:8080` 或 `socks5://1.2.3.4:1080`)
  - `pacScript?`, `proxyBypassRules?`
  - 返回 Promise,**必须 await 之后再 loadURL**,否则首个请求可能走直连。
- `ses.setUserAgent(userAgent: string, acceptLanguages?: string)` —— 同时能改 `Accept-Language`。
- `ses.setPermissionRequestHandler(handler | null)` —— 按实例控制地理位置/通知/媒体等授权。
- `ses.clearStorageData(options?)` / `ses.clearCache()` —— 重置实例环境。
- 代理鉴权(账号密码代理):`app.on('login', ...)`。⚠️ 签名是 **5 个参数**(容易写错成 4 个):
  `(event, webContents, authenticationResponseDetails, authInfo, callback)`;`authInfo.isProxy === true` 时
  `event.preventDefault()` 再 `callback(user, pass)`。`webContents` 可能为 `null`(来自 utility process)。
- ⚠️ `setProxy()` 之后**必须** `await ses.closeAllConnections()` —— 官方文档原话:否则连接池里使用旧代理的 socket 会被后续请求复用。
  多账号多代理场景下,这等于某个账号的流量从别人的出口 IP 出去。
- `webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` —— 挂代理时防止 WebRTC 暴露真实内网/公网 IP。
- `ses.resolveProxy(url)` —— 体检代理是否真的生效。

## 4. 每实例时区 / 语言 / 地理位置

- `webContents.debugger`(`readonly debugger: Debugger`),`dbg.attach()` + `dbg.sendCommand(method, params?, sessionId?)`。
- 可用命令:`Emulation.setTimezoneOverride({ timezoneId })`、`Emulation.setLocaleOverride({ locale })`、`Emulation.setGeolocationOverride({...})`、`Network.setUserAgentOverride({ userAgent, acceptLanguage, platform })`。
- ⚠️ `debugger.attach()` 与 **DevTools 互斥**:开了 DevTools 就 attach 不上(反之亦然)。要在打开 DevTools 前 detach。

## 5. 性能

- `webPreferences.backgroundThrottling`(默认 true)。⚠️ 文档明确:**同一窗口内只要有一个 webContents 关掉了 backgroundThrottling,整个窗口的帧调度都会受影响**。
- `webContents.setBackgroundThrottling(allowed: boolean)` 可运行时改。
- **实测**(#6):被 `setVisible(false)` 的 View 依然能收 `sendInputEvent` 并正确命中,`getBoundingClientRect()` 也返回正确值(未被节流成陈旧值)。→ 隐藏实例是一等公民,"可见格子数"与"抢购能力"解耦。

## 6. 抢购相关

- `ses.webRequest.onHeadersReceived(filter?, listener)` —— 拿目标站响应头里的 `Date` 做时钟校准。
- `webContents.executeJavaScript(code, userGesture?)` —— `userGesture: true` 能满足部分需要用户手势的 API。
- `webContents.setWindowOpenHandler(details => WindowOpenHandlerResponse)` —— 拦 `window.open`,把新页面收进实例的标签页体系,而不是弹出 OS 窗口。
- `webContents.setZoomFactor(factor)` —— **实测确认**:zoom=0.5 时 440×520 的 view 页面 `innerWidth` 变 880×1040,注入坐标必须 `× zoomFactor`(实测 #9)。
- `app.getPath('userData' | 'sessionData' | 'logs' | 'temp' | ...)`。

## 7. 合规边界(写死在项目里)

不实现:验证码识别/打码平台对接、指纹伪造(canvas/WebGL/AudioContext 噪声注入)、请求层协议模拟(绕过前端直接打下单接口)、任何以规避风控检测为目的的特征伪装。
遇到验证码的正确处理:该实例自动升为焦点 + 告警,等人工处理完再继续。
