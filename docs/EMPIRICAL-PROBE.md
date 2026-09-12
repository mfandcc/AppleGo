# 实测结论(Electron 44.3.0 / macOS arm64 / 2026-09-11)

探针源码:`docs/probe-electron.js`(可重跑:`node_modules/.bin/electron docs/probe-electron.js`)。
页面用本地 http server 提供真实 origin(data: URL 顶层导航在 Chromium 里被禁,localStorage 也会抛 SecurityError)。

| # | 问题 | 实测结论 | 对架构的影响 |
|---|------|---------|------------|
| 1 | `sendInputEvent` 的 x/y 相对谁? | **相对 WebContentsView 自身左上角**。两个 bounds 原点不同的 view(0,0 和 450,40),用同一组 (110,100) 都命中了各自页面里的 `#pad`,页面收到 `clientX/clientY = 110/100`。 | 主从坐标可直接复用页面 CSS 坐标,**不需要**做窗口偏移换算。 |
| 2 | 注入事件的 `isTrusted`? | **`true`**。鼠标与键盘都是。 | ✅ 站点的 isTrusted 校验能过。⚠️ **从机 preload 会把注入事件当成用户操作重新上报 → 自激循环。必须断环。** |
| 3 | 双击怎么发? | 连发 `clickCount:1` 的 down/up,再发 `clickCount:2` 的 down/up。页面依次收到 `mousedown:1 mouseup:1 click:1 mousedown:2 mouseup:2 click:2 dblclick:2`。 | 双击同步照抄 clickCount 即可。 |
| 4 | `mouseWheel` 要不要 `canScroll:true`? | **不需要**。不带该字段也滚动了 120px,带上再滚 120px。 | 文档没写默认值,实测默认就能滚。仍建议显式带上以防跨平台差异。 |
| 5 | 键盘能真正输入文字吗? | 能。`keyDown`→`char`→`keyUp`,keyCode `'h'`/`'i'` 得到 `"hi"`;`keyCode:'A' + modifiers:['shift']` 得到 `"A"`。页面侧 `e.code` 正确解析为 `KeyH`/`KeyI`/`KeyA`,`isTrusted:true`。 | 键盘同步可用。 |
| 6 | `setVisible(false)` 的 view 还能收输入吗? | **能**。隐藏后注入点击仍命中 `#pad`,且 `getBoundingClientRect()` 返回值正常(未被节流成陈旧值)。 | ✅ **不可见实例照样能抢购**。网格只需渲染可视范围,N 可以远大于屏幕能放下的格子数。 |
| 7 | `fromPartition` 隔离到什么程度? | A 写 `localStorage`,B(另一个 partition)读到 `null`,C(同一 partition)读到 A 写的值。 | 账号隔离成立,partition 是实例环境的边界。 |
| 8 | 每实例时区/语言能覆盖吗? | 能。`debugger.attach('1.3')` + `Emulation.setTimezoneOverride` / `setLocaleOverride` 后该 view 变成 `America/New_York` + `ja-JP`,而同进程另一个 view 仍是 `America/Los_Angeles`。 | 时区/语言可按 profile 隔离(CDP 作用域是单个 webContents)。 |
| 9 | **`zoomFactor` 会不会破坏坐标同步?** | **会。** view 物理 440×520 + `setZoomFactor(0.5)` → 页面 `innerWidth/Height = 880×1040`,`devicePixelRatio` 由 2 变 1。用页面 CSS 坐标 (110,100) 注入 → 页面收到 **(220,200)**,打空;用 (55,50) 注入 → 页面收到 (110,100),命中。 | **`sendInputEvent` 收的是 view 物理坐标(DIP),页面 clientX = x / zoomFactor。** 换算公式固定为 `viewX = cssX * zoomFactor`。这是坐标同步最容易翻车的地方。 |
| 10 | 宿主窗口失焦后还能注入吗? | 官方文档说"窗口必须 focused",但**实测 `win.blur()` 之后注入依然生效**(点击照样命中)。 | 放宽了"必须单窗口"的硬约束,分离式中控窗口可行。但只在 macOS/Electron 44 验证过,**不作为保证**:关键时刻(定时任务触发前)仍然先 `stageWin.focus()` 兜底。 |
| 11 | 分发延迟有多大? | 50 次 `sendInputEvent` 共 **449μs(约 9μs/次**,fire-and-forget 不等渲染进程);`executeJavaScript('1+1')` 往返 **135μs**。 | N=50 的坐标广播 < 0.5ms;语义定位(每实例一次 executeJavaScript)并发下也只有几 ms。**延迟预算非常宽裕,瓶颈不在 IPC 而在页面自身的 JS/布局。** |

## 由实测推出的三条硬性设计规则

1. **坐标必须过 zoom 换算**:任何 `sendInputEvent` 的坐标 = `页面CSS坐标 × 该实例的 zoomFactor`。统一走 `SyncEngine.toViewCoords(instance, cssX, cssY)`,禁止裸写坐标。
2. **必须断自激环**(因为 isTrusted 为 true,从机分不出注入还是真人):三重保险 —— ① 只有 master 的 preload 处于捕获态;② 主进程注入前给该实例设 `muteUntil`,静默窗口内丢弃其上报;③ 事件带 `originInstanceId`,非 master 来源一律丢弃。
3. **隐藏实例是一等公民**:`setVisible(false)` 不影响输入与 DOM 测量,所以"可见格子数"纯粹是 UI 问题,和抢购能力解耦。

---

# 第二轮实测(架构评审提出的三点质疑,逐条验证)

探针源码:`docs/probe-zoom-cdp.js`。

| # | 质疑 | 实测结果 | 结论 |
|---|------|---------|------|
| 12 | CDP 的时区/语言覆盖会不会在导航后丢失? | **不会。** 同源导航、跨源导航(跳到 example.com)、再跳回来,`Intl.DateTimeFormat().resolvedOptions().timeZone` 始终是 `America/New_York`,`debugger.isAttached()` 仍为 true。 | 评审的"每次导航都要重放"是**多余的**。只有 debugger 被 detach(开 DevTools)或渲染进程崩溃重建 target 时才需要重放 —— 按这两个事件重放即可。 |
| 13 | **`mouseWheel` 的 delta 会不会也被 zoom 换算?** | **会。** view 物理 600 宽,zoom=0.5 时发 `deltaY:-240` → 页面收到 `deltaY:480`(= 240/0.5)、滚动 480 CSS px;zoom=1 时发 -240 → 页面收到 240。 | **delta 和坐标一样,收的是 view 物理量,页面值 = 发送值 / zoom。** 所以要让从机滚动和主机相同的 CSS 距离,必须 `viewDelta = cssDelta × zoomFactor`。原实现直接透传 delta,在 zoom=0.539(Apple 网格)下从机会多滚 1.85 倍。**已修。** |
| 14 | `zoomFactor` 的真实下限是多少? | view 物理 600 宽时:zoom 0.5 → `innerWidth` 1200;zoom **0.25 → 2400**;zoom 0.2 → 仍然 2400;zoom 0.1 → 仍然 2400。而 `getZoomFactor()` 对 0.2/0.1 **照样返回 0.2/0.1**。 | **Chromium 的布局缩放在 0.25 触底,但 `getZoomFactor()` 不会告诉你它被钳位了 —— 它会说谎。** 格子物理宽 < 1280×0.25 = 320px 时,若仍按名义 zoom 换算坐标,注入点整体偏移、全部打空。**已修:落 zoom 后回读 `innerWidth`,用 `物理宽 / innerWidth` 反算出"真实生效的 zoom",拿它去换算坐标 —— 测量,而不是假设。** |
| 15 | `session.closeAllConnections()` / `setWebRTCIPHandlingPolicy` 可用吗? | 都可用。`resolveProxy('https://www.apple.com.cn/')` 返回 `PROXY 127.0.0.1:6152`(本机确实挂着代理)。 | Electron 官方文档在 `setProxy` 处明确写了:**需要 `closeAllConnections()`,否则连接池里用旧代理的 socket 会被后续请求复用。** 多账号场景下这意味着某个账号的流量从错误的出口 IP 出去。**已修。** |
