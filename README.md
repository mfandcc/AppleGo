<div align="center">

<img src="build/icon.png" width="112" alt="AppleGo">

# AppleGo

**嵌入式多页面 · 多开 · 主从鼠标同步 · 独立环境**的中控抢购系统

[![build](https://github.com/TgolMsk/AppleGo/actions/workflows/build.yml/badge.svg)](https://github.com/TgolMsk/AppleGo/actions/workflows/build.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![electron](https://img.shields.io/badge/Electron-44-47848F.svg)](https://electronjs.org)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)

主要适配目标:**Apple 中国大陆官网(apple.com.cn)**

</div>

---

## 安装

到 [Releases](https://github.com/TgolMsk/AppleGo/releases) 下载:

| 平台 | 文件 |
|---|---|
| macOS(Apple 芯片) | `AppleGo-*-arm64.dmg` |
| macOS(Intel) | `AppleGo-*-x64.dmg` |
| Windows 安装版 | `AppleGo-*-win-x64-setup.exe` |
| Windows 免安装 | `AppleGo-*-win-x64-portable.exe` |

> **安装包没有代码签名。** macOS 首次打开右键 → 打开;Windows 的 SmartScreen 点"更多信息 → 仍要运行"。
> 不放心就从源码跑,下面就是。

## 从源码运行

```bash
npm install
npm start            # 启动中控台
npm test             # 95 个单元测试(纯 Node,秒级)
npm run test:e2e     # 端到端,会拉起真实 Electron 窗口
```

## 自己打包

```bash
npm run dist:mac     # macOS:dmg + zip(arm64 / x64)
npm run dist:win     # Windows:nsis 安装包 + 免安装版
npm run pack         # 只打目录,不出安装包,调试用最快
```

图标由 `build/icon.svg` 经 `npm run icon` 渲染成 `build/icon.png`,
electron-builder 再自动生成各平台格式 —— 不需要额外的图形工具。

---

## 它解决什么问题

同时开 N 个互不串号的浏览器环境,你只操作**主机**一个,其余**从机**跟着做同样的事;
到点由定时器统一开火,命中与否逐个可查。

| 能力 | 实现 |
|---|---|
| 嵌入式 | 所有实例是原生 `WebContentsView`,嵌在同一个宿主窗口里由中控台统一排布,不是一堆乱飞的 OS 窗口 |
| 多页面 | 每个实例内部可开多个标签页,`window.open` 被收进标签页体系而不是弹窗 |
| 多开 | 目标 4~50 个实例;**屏幕放不下的实例照样能同步**(实测:`setVisible(false)` 的 view 仍能接收输入并正确测量 DOM) |
| 主从同步 | 主机的鼠标/滚轮/按键复现到所有从机,走**语义定位 + 真实输入注入**(见下) |
| 独立环境 | 每实例独立 session:cookie / localStorage / IndexedDB / SW / HTTP 缓存 / 代理(含账号密码)/ UA / 时区 / 语言 / 权限 / 下载目录 |
| 中控 | 实例看板、批量导航、剧本执行、定时抢购、时钟校准、告警与事件流 |

---

## 主从同步为什么这么设计

**只同步坐标是不行的。** 从机和主机虽是同一个站点,但登录态、A/B 分流、有没有弹优惠券、懒加载进度都可能不同,
同一像素位置上很可能是别的东西。端到端测试里有一条专门的对照:主机点「立即抢购」,从机上因为多了一个优惠券弹窗,
**纯坐标同步点中的是弹窗**。

**只用 `element.click()` 也不行。** 那样产生的事件 `isTrusted` 是 `false`,部分站点不认。

所以是两段式:

```
主机 preload 捕获真实操作
  → 算出目标元素的"画像"(id / data-autom / aria / 文本 / CSS 路径 / 尺寸 / 点击偏移)
  → 主进程并发下发给每个从机
  → 从机在自己的 DOM 里重新找回这个元素,算出它此刻的落点坐标
  → 主进程对该从机 sendInputEvent 打这个坐标  ← 真实输入,isTrusted 为 true
  → 隔一拍回头核对:这一下到底点中了没有、点中的是不是想要的那个
```

定位靠 DOM(**准**),点击靠系统输入(**真**)。找不到或有歧义时,`auto` 模式退回坐标同步,
`semantic` 模式宁可不点也不乱点 —— 抢购里点错比没点更糟。

### 三道闸门防自激

实测:`sendInputEvent` 注入的事件在页面里 `isTrusted === true`,**页面和 preload 都分不出真假**。
所以从机会把收到的注入当成"用户操作"再上报一遍,形成自激风暴。三道独立的闸门:

1. 从机的 preload 根本不挂捕获器(按角色开关)
2. 主进程注入前给该实例设静默窗口,窗口内它的上报一律丢弃
3. 上报者身份只从 `event.sender` 推导,不信页面自报的 id;非当前主机来源一律丢弃

端到端测试里有一条反证:**把全部实例都误设成 master,也不会产生事件风暴。**

---

## Apple 中国大陆

选择器不是猜的,是直接在 `www.apple.com.cn` 的实时 DOM 上枚举出来的 —— 单个配置页有 **175 个 `data-autom` 属性**,
整条购买链路都靠它定位。全部落在 [`src/shared/presets/apple-cn.js`](src/shared/presets/apple-cn.js)。

```
颜色    [data-autom="dimensionColor<黑色/白色/…>"]
容量    [data-autom="dimensionCapacity<256gb/512gb/…>"]
换购    [data-autom="choose-noTradeIn"] / choose-tradeIn
保障    [data-autom="noapplecare"] / acp
加购    [data-autom="add-to-cart"]        ← 注意不是 continueButton
购物袋  [data-autom="gn_bag"]
```

针对 Apple 做的三处适配,每一处都是实站上踩出来的:

1. **`data-autom` 被提到定位属性的第一位** —— 它是 Apple 全站最稳的锚点。
2. **Apple 的元素 id 是 React 19 的 `useId` 产物**(`_r_c_`、`_r_14_`),每次渲染都变。
   不把它列入"不稳定 id"黑名单,从机会拿着上次渲染的 id 去找元素,必然落空。
3. **颜色/容量是 `opacity:0` 的单选框铺在样式化 `<label>` 上**。
   早先把"透明"一律判为不可点,导致实站上 `waitFor` 永远等不到、整条剧本卡死。
   现在透明的表单控件照常可点,且必要时改打它的 `<label>` —— 这也正是真人的做法。

还有一处容易踩空的:**配置没选完时页面上只有 `continueButton`("继续");全部选定后它消失,换成 `add-to-cart`("添加到购物袋")**,
同时 URL 变成 `/shop/buy-iphone/iphone-17/MG6W4CH/A` —— 那串是零件号,记下来下次可以直达已配置好的页面,整段跳过配置流程。

### iPhone 18 Pro Max 首发(2026-09-12 20:00 北京时间)

实站确认过的事实,全部写在 `src/shared/presets/apple-cn.js`:

| | |
|---|---|
| 配置页 | `https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro` ——  **Pro 和 Pro Max 共用一页**,`iphone-18-pro-max` 这个 URL 是 404 |
| 选 Pro Max | `[data-autom="dimensionScreensize6_9inch"]` —— **17 系列没有这一维**,漏了这步永远选不到 Max |
| 颜色 | burgundy 勃艮第酒红 / glacier 冰川蓝 / silver 银 / black 黑 |
| 容量 | 256GB ¥9,999 · 512GB ¥11,999 · 1TB ¥15,499 · 2TB ¥20,499 |
| 预购 | 9/12 **晚 8 点**(北京时间)开始,9/18 发售,**每人限购 2 部 Pro + 2 部 Pro Max** |
| 零件号 | 256GB 黑色 = `MJY64CH/A`,可直达 `/shop/buy-iphone/iphone-18-pro/MJY64CH/A` 跳过整个配置流程 |

**首发和日常抢购是两种打法**,原因是实测出来的一条事实:

> 开售前,配置页上**根本没有「添加到购物袋」按钮**,只有「继续」。
> 但所有配置项(尺寸/颜色/容量/换购/AppleCare)**开售前就能选**,选完 URL 会变成带零件号的地址。

所以"预热落点 → 到点开火"在首发用不上 —— 没有落点可以预热。正确姿势是**守株待兔**:

1. 提前把配置全部选好停在那儿(所有实例)
2. 在每个实例的页面里挂一个 `MutationObserver` 盯着 `[data-autom="add-to-cart"]`
3. 按钮一出现,观察器**主动上报**给主进程,主进程当场注入点击

事件驱动,不轮询。端到端测过:**按钮出现到点中 5ms**(`npm run test:e2e:preorder` 会往页面里插一个假的加购按钮来模拟开售那一刻,不用等到 8 点)。

中控台里就是「Apple 中国抢购 → ④ 首发预购:配好并守株待兔」这一个按钮。

⚠️ **时间显示一律主显北京时间**。跑这个工具的机器不一定在中国 —— 本机若在美西,北京时间 9/12 20:00 会显示成 9/12 05:00,照着等就直接错过。所有时刻都写成「北京时间 … (本机 …)」,任务时间输入框里填的也按北京时间解析(`src/shared/time.js`,有专门的单元测试)。

### 建议流程

1. **套用环境 + 对表** —— 把时区 `Asia/Shanghai`、语言 `zh-CN` 刷到每个实例,并用 apple.com.cn 自己的响应头 `Date` 校准时钟
2. **各实例分别登录**(或在主机登录后用「克隆登录态」把 cookie 复制过去),把收货地址和支付方式配好
3. **推进到「只差一下」** —— 剧本把所有实例推到"选项全选完、add-to-cart 已就绪"的状态并预热
4. **到点开火** —— 关键路径只剩一次输入注入

---

## 时钟校准

HTTP 的 `Date` 响应头只有**秒级**精度,直接相减最多只能精确到 ±1000ms。这里用区间收敛:

> 收到 `Date: S`(整秒)时,真实服务器时间 ∈ [S, S+1000);请求在本地 t0 发出、t1 收到
> ⟹ `offset ∈ [S − t1, S + 1000 − t0)`

多个样本求交集。关键在于样本要**骑在服务器的整秒边界上** —— 边界前一刻把上界压下来,边界后一刻把下界顶上去。
随机取样要靠运气碰到边界,所以取样相位是自适应的:先粗估,再主动瞄准推算出的边界前后各取一枪。

模拟下 RTT=40ms、20 个样本:固定相位 ±58ms → **自适应 ±22ms**(理论下界是 RTT/2 = 20ms)。
实站对 apple.com.cn 通常收敛到 ±300ms 上下(Apple 的 CDN 抖动较大),测到过本机时钟慢 285~728ms —— 这个量级足以决定成败。

开火时用三段式定时:粗睡 → 细轮询 → 最后几毫秒自旋,避开 `setTimeout` 在高负载下的漂移。

---

## 关于"注入成功"和"真的点中了"

`sendInputEvent` 不抛错只说明事件发出去了,**不说明页面上有东西被点到**。弹窗盖住、按钮 disabled、元素刚好重排走了,
都会让它静默落空。不核对的话中控台会出现"50 个格子全绿、实际一单没成"。

所以每个被控页面里都有一个**只记录、永不上报**的点击环形缓冲,注入之后隔一拍由主进程拉取:
这一下有没有点到东西、点到的是不是想要的那个。中控台区分显示 **注入 N/N · 生效 M/N**。

---

## 布局:渲染层量,主进程摆

实例是原生 view,盖在中控台 HTML 之上,CSS 的 blur/圆角/阴影对它无效。所以:

- 格子的**外框**(玻璃卡片、标题栏、状态灯、主控徽章)由渲染层画
- 渲染层用 CSS Grid 排好版,量出每个格子内容区的 `getBoundingClientRect()` 上报
- 主进程只负责把 view 照着这些矩形摆好

改版只改 CSS,主进程一行不用动。

### 统一逻辑视口

格子物理尺寸可能只有 400×300,若就让页面按 400px 宽渲染,各实例会落进不同的响应式断点 ——
主机是桌面版布局、从机是移动版,同步必然打偏。所以反过来用 `zoomFactor`:
`zoom = 格子物理宽 / 1280`,页面永远以为自己有 1280px,所有实例布局完全一致。

⚠️ 两个坑都已处理:
- **缩放会被导航重置**(Chromium 按 origin 记缩放)。只在布局时设一次,页面一跳转就悄悄回到 1,
  而记录里还是旧值 —— 坐标按一个没生效的缩放去换算,从机全部打空。现在每次导航完重新施加。
- **`getZoomFactor()` 会说谎**。格子窄到一定程度,Chromium 把布局缩放钳在 0.25,但 `getZoomFactor()` 照样返回你请求的 0.1。
  现在改成**测量**:落 zoom 后回读 `innerWidth`,用 `物理宽 / innerWidth` 反算真实生效的缩放,拿它去换算坐标。

---

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/EMPIRICAL-PROBE.md`](docs/EMPIRICAL-PROBE.md) | **15 条实测结论**,每条都有可重跑的探针。坐标系、`isTrusted`、隐藏 view 能否收输入、zoom 与坐标/滚轮 delta 的关系、CDP 覆盖的生命周期…… |
| [`docs/ELECTRON-API-FACTS.md`](docs/ELECTRON-API-FACTS.md) | 直接读 `electron.d.ts` 求证的 API 事实清单 |
| [`docs/DESIGN-LANGUAGE.md`](docs/DESIGN-LANGUAGE.md) | 设计语言,色值逐像素采样自参考图 |
| `docs/probe-*.js` | 探针源码,可直接 `electron docs/probe-electron.js` 重跑 |

实测里最该记住的三条:

1. `sendInputEvent` 的坐标相对 **view 自身左上角**,收的是**物理坐标**:`viewX = cssX × zoomFactor`。滚轮的 delta 同理。
2. 注入事件 `isTrusted` 为 **true** —— 好处是站点校验能过,代价是必须自己断自激环。
3. `setVisible(false)` 的 view **照样能收输入、照样能测 DOM**。屏幕放不下不等于不能抢。

---

## 边界与免责

这是一个**多账号浏览器 + 输入同步**工具。它做的事等价于"你开了 N 个互不串号的浏览器窗口,
在其中一个里点一下,其余的跟着点同一个按钮"。所有点击都是真实的系统级输入事件,页面看到的和真人操作没有区别。

**不做,也不会接受相关 PR:**

- ❌ 验证码识别、打码平台对接
- ❌ 指纹伪造(canvas / WebGL / AudioContext 噪声注入等,以规避风控为目的的特征伪装)
- ❌ 绕过前端直接调下单接口的协议模拟

**做的:** 代理 / UA / 时区按 profile 隔离(正常的多账号环境管理);关闭非代理 UDP 防止 WebRTC 泄漏真实 IP(防泄漏)。

遇到验证码或排队页,该实例会被自动标为「待人工」、升到可视区第一格并告警,**由人处理**。

### 免责声明

- 本项目按 MIT 协议开源,**不提供任何担保**。
- 使用者需自行遵守目标站点的服务条款与销售条款,**包括限购数量** —— Apple 的商品页上就写着每位顾客的限购台数。
- 作者不对使用本工具产生的任何后果(账号受限、订单取消等)负责。
- 本项目与 Apple Inc. 无任何隶属或背书关系。文中出现的商标归各自所有者。

---

## 结构

```
src/
  main/
    index.js                 应用入口:单宿主窗口,中控 UI 是窗口自身的 webContents,实例 view 叠在其上
    core/
      InputCodec.js          DOM 事件 → Electron 输入事件。全项目唯一做 zoom 坐标/位移换算的地方
      Locator.js(shared)    语义定位:描述元素 → 在别的实例里找回来
      SyncEngine.js          主从分发、三道闸门、预热与开火、守株待兔、注入后核对
      GuestRpc.js            主进程 ↔ 被控页面 preload 的请求/响应通道
      Instance.js            一个多开位:独立环境 + 多标签页 + 统一逻辑视口
      InstanceManager.js     生命周期、批量操作、把渲染层量的矩形落到 view
      SessionFactory.js      独立环境的全部实现:session/代理/UA/时区/权限/拦截
      Clock.js               服务器时钟校准(区间收敛 + 自适应相位)+ 高精度定时
      TaskScheduler.js       定时抢购:预热 → 复检 → 开火
      PlaybookRunner.js      剧本执行,点击带断言重试
      Store.js / Logger.js   原子写配置 / 结构化日志
    ipc/handlers.js          IPC 路由
  preload/
    guest.js                 注入被控页面:按角色捕获、语义解析、预热、填表、验证码检测、点击结果观测
    control.js               中控台 preload,只暴露白名单 API
  shared/
    ipc.js                   IPC 契约(主/渲染共用的唯一真相)
    Locator.js               定位引擎
    time.js                  时间处理:输入按北京时间解析、显示主显北京时间(本机不在中国时这是关键)
    presets/apple-cn.js      Apple 中国大陆预设(机型/选项表 + 首发预购方案)
  renderer/control/          中控台 UI(原生 ES module,无构建步骤)
```

测试:**76 个单元测试 + 3 组端到端全绿**

| 套件 | 结果 | 验证什么 |
|---|---|---|
| `npm test` | 95/95 | 坐标与滚轮的 zoom 换算、键位映射、时钟区间收敛与抗杂样本、同步引擎三道闸门、原子写盘 |
| `test/e2e/locator.e2e.js` | 13/13 | 布局不同的从机上语义定位能否找回元素;含"纯坐标同步会点中弹窗"的对照 |
| `test/e2e/sync.e2e.js` | 16/16 | 真实 preload + SyncEngine 跑完整链路;含"全员误设为 master 不产生风暴"的反证 |
| `test/e2e/apple-cn.e2e.js` | 12/12 | **真实 apple.com.cn**:配置流程跑通、选项确实选中、时区语言生效、三个实例的 `dssid2` 互不相同 |
| `test/contrast.test.js`(含在 `npm test`) | 11/11 | 直接读 `tokens.css` 的真实色值跑 WCAG 校验 —— 配色一旦退化就红 |
| `test/e2e/apple-preorder.e2e.js` | 12/12 | **真实 18 Pro Max 预购链路**:选中 6.9 吋 Max、拿到零件号、确认开售前没有加购按钮、守株待兔布防、模拟按钮出现后 5ms 内扑中 |
