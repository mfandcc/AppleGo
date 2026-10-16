'use strict'
/**
 * Apple 中国大陆官网(apple.com.cn)预设。
 *
 * 选择器不是猜的,是 2026-09-11 直接在 www.apple.com.cn/shop/buy-iphone/iphone-17 的实时 DOM 上
 * 枚举出来的:单个配置页有 175 个 data-autom 属性,整条购买链路全靠它定位。
 *
 * 两条针对 Apple 的关键适配(都已落到 Locator 里):
 *   1. data-autom 被提到 TEST_ATTRS 的第一位 —— 它是 Apple 全站最稳的定位锚点。
 *   2. Apple 的元素 id 是 React 19 的 useId 产物(`_r_c_`、`_r_14_`),每次渲染都变,
 *      已加入 UNSTABLE_ID 黑名单。不加这条,从机会按一个上次渲染的 id 去找元素,必然落空。
 *
 * 合规边界:本预设只做"把人工点击复现到多个已登录的独立环境"。
 * 不含验证码绕过、不含指纹伪造、不含直接调用下单接口。
 * 遇到验证码/风控由 guest preload 检测并把该实例升为焦点,交给人处理。
 * 使用者需自行遵守 Apple 的销售条款(含限购数量)。
 */

const ORIGIN = 'https://www.apple.com.cn'

/** 环境:Apple 中国站按地区/语言分流,时区语言要对齐,否则可能被重定向到别的商店 */
const profileDefaults = {
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  acceptLanguages: 'zh-CN,zh;q=0.9,en;q=0.8',
  permissions: { geolocation: false, notifications: false, media: false },
  // 抢购时图片对成败没帮助,多开时挡掉能省不少内存和带宽;想看页面就设成 'none'
  blockResources: 'none',
}

/** 时钟校准:直接打 Apple 自己的边缘节点,拿它响应头的 Date */
const clockSource = ORIGIN + '/'

const urls = {
  home: ORIGIN + '/',
  iphone: ORIGIN + '/shop/buy-iphone',
  bag: ORIGIN + '/shop/bag',
  checkout: ORIGIN + '/shop/checkout',
  orderStatus: ORIGIN + '/shop/order/list',
  signIn: ORIGIN + '/shop/signIn',
  buyModel: model => `${ORIGIN}/shop/buy-iphone/${model}`,
  /**
   * 直达已配置好的型号。
   * 配置完成后 URL 会变成 /shop/buy-iphone/iphone-17/MG6W4CH/A —— 那串就是零件号(part number)。
   * 抢购时把它记下来直接跳,能整段跳过配置流程,页面一开就只差"添加到购物袋"一下。
   */
  part: (model, partNumber) => `${ORIGIN}/shop/buy-iphone/${model}/${String(partNumber).toUpperCase()}`,
}

/**
 * 配置页(/shop/buy-iphone/<model>)上的定位锚点。
 * 全部是 data-autom 值,用法:`[data-autom="..."]`
 */
const autom = {
  /* —— 全局导航 —— */
  bag: 'gn_bag',                                  // 购物袋入口(id 也稳定:#globalnav-menubutton-link-bag)
  search: 'globalnav-search',

  /* —— 机型配置:值都是拼接出来的 —— */
  // ⚠️ Pro / Pro Max 共用一个配置页,靠 dimensionScreensize 区分。
  //    iphone-18-pro-max 这个 URL 是 404,别去拼它。
  //    17 系列没有这一维,18 Pro 有 —— 漏了这一步就永远选不到 Pro Max。
  screensize: v => 'dimensionScreensize' + v,     // 6_3inch(Pro) / 6_9inch(Pro Max)
  color: v => 'dimensionColor' + v,
  capacity: v => 'dimensionCapacity' + v,         // 256gb / 512gb / 1tb / 2tb
  model: v => 'dimensionModel' + v,

  /* —— 换购 / AppleCare:抢购时几乎一定是选"不要",少一步是一步 —— */
  noTradeIn: 'choose-noTradeIn',
  tradeIn: 'choose-tradeIn',
  noAppleCare: 'noapplecare',
  appleCare: 'acp',

  /* —— 推进 —— */
  // ⚠️ 这两个按钮是**互斥**的,实站验证过:
  //   配置没选完时页面上只有 continueButton("继续");
  //   全部选项选定后 continueButton 消失,换成 add-to-cart("添加到购物袋"),
  //   同时 URL 变成 /shop/buy-iphone/<model>/<partNumber>/a。
  // 剧本里必须等 add-to-cart,等 continueButton 会永远超时。
  continue: 'continueButton',
  addToCart: 'add-to-cart',
  summaryEdit: 'summary-view-edit-link',
  saveForLater: 'save-for-later',

  /* —— 购物袋页 —— */
  bagEmptySignIn: 'bag-empty-signin-button',
  bagEmptyContinue: 'bag-empty-continueshopping-button',
  bagError: 'bag-error-message',

  /* —— 价格(用来校验配置选对了) —— */
  headerPrice: 'headerPrice',
  summaryPrice: 'summaryPrice',
}

const sel = a => `[data-autom="${a}"]`

/**
 * 各机型的实测选项表(2026-09-11 在 apple.com.cn 实时 DOM 上枚举)。
 * 值就是 data-autom 后缀,照着拼即可。
 */
const models = {
  'iphone-18-pro': {
    title: 'iPhone 18 Pro / Pro Max',
    // 这一维是 18 Pro 独有的,选 Pro Max 全靠它
    screensizes: [
      { v: '6_3inch', t: 'iPhone 18 Pro(6.3 吋)' },
      { v: '6_9inch', t: 'iPhone 18 Pro Max(6.9 吋)' },
    ],
    colors: [
      { v: 'burgundy', t: '勃艮第酒红色' },
      { v: 'glacier', t: '冰川蓝色' },
      { v: 'silver', t: '银色' },
      { v: 'black', t: '黑色' },
    ],
    capacities: [
      { v: '256gb', t: '256GB · ¥9,999 起' },
      { v: '512gb', t: '512GB · ¥11,999 起' },
      { v: '1tb', t: '1TB · ¥15,499 起' },
      { v: '2tb', t: '2TB · ¥20,499 起' },
    ],
    /** 预购开始:2026-09-12 20:00 北京时间;9/18 发售;每人限购 2 部 Pro + 2 部 Pro Max */
    preorder: { at: '2026-09-12T20:00:00+08:00', release: '2026-09-18', limitPerCustomer: 2 },
    /** 实测到的零件号,可直达已配置页面,整段跳过配置流程 */
    knownParts: { '6_9inch/black/256gb': 'MJY64CH/A' },
  },
  'iphone-duo': {
    title: 'iPhone Duo(折叠屏)',
    // 单一尺寸(7.6 吋内屏 / 5.4 吋外屏),没有 dimensionScreensize 这一维
    screensizes: null,
    // ⚠️ 颜色 data-autom 后缀是按 Apple 惯例(英文名小写连写,如 mistblue)推断的,
    //    开售前商店处于预购封面页,未能在实时 DOM 上核实;首发前请在实站上确认一次。
    colors: [
      { v: 'starwhite', t: '星光白色' },
      { v: 'nightsky', t: '夜空色' },
    ],
    capacities: [
      { v: '256gb', t: '256GB · ¥15,999 起' },
      { v: '512gb', t: '512GB · ¥17,999 起' },
      { v: '1tb', t: '1TB · ¥21,499 起' },
      { v: '2tb', t: '2TB · ¥26,499 起' },
    ],
    /** 预购开始:2026-10-16 20:00 北京时间;10/23 发售。仅支持 eSIM,国行型号 A3721。限购数量官方未公布 */
    preorder: { at: '2026-10-16T20:00:00+08:00', release: '2026-10-23', limitPerCustomer: null },
    /** 零件号尚未实测到(开售前拿不到),拿到后按 'color/capacity' 填进来 */
    knownParts: {},
  },
  'iphone-17': {
    title: 'iPhone 17',
    screensizes: null,
    colors: [
      { v: 'lavender', t: '薰衣草紫' }, { v: 'mistblue', t: '雾蓝色' },
      { v: 'white', t: '白色' }, { v: 'sage', t: '鼠尾草绿' }, { v: 'black', t: '黑色' },
    ],
    capacities: [{ v: '256gb', t: '256GB' }, { v: '512gb', t: '512GB' }],
  },
}

/**
 * 抢购剧本:一条从配置页到购物袋的标准路径。
 * 每一步都是"等它出现 → 点它",点用的是真实输入注入(isTrusted 为 true),不是 element.click()。
 *
 * @param {object} opts { model, color, capacity, appleCare, tradeIn }
 */
function buyPlaybook(opts = {}) {
  const o = { model: 'iphone-17', color: 'black', capacity: '256gb', appleCare: false, tradeIn: false, screensize: null, ...opts }
  const steps = [
    { op: 'navigate', url: o.partNumber ? urls.part(o.model, o.partNumber) : urls.buyModel(o.model) },
  ]
  // 尺寸必须最先选:它一变,颜色/容量的可选项会整组重渲染,先选别的会被冲掉
  if (o.screensize) {
    steps.push({ op: 'waitFor', selector: sel(autom.screensize(o.screensize)), timeoutMs: 20000 })
    steps.push({ op: 'click', selector: sel(autom.screensize(o.screensize)),
                 label: '选尺寸 ' + o.screensize, expectChecked: true, settleMs: 500 })
  }
  steps.push(
    { op: 'waitFor', selector: sel(autom.color(o.color)), timeoutMs: 15000 },
    // 这几步都是单选框,Apple 每选一次都会重渲染右侧摘要;
    // expectChecked 让 runner 点完回读一次 .checked,没选上就重试 —— 实站上确实会偶发漏选。
    { op: 'click', selector: sel(autom.color(o.color)), label: '选颜色 ' + o.color, expectChecked: true },
    { op: 'click', selector: sel(autom.capacity(o.capacity)), label: '选容量 ' + o.capacity, expectChecked: true },
    { op: 'click', selector: sel(o.tradeIn ? autom.tradeIn : autom.noTradeIn), label: o.tradeIn ? '换购' : '不换购', expectChecked: true },
    { op: 'click', selector: sel(o.appleCare ? autom.appleCare : autom.noAppleCare), label: o.appleCare ? '加 AppleCare+' : '不要 AppleCare+', expectChecked: true },
  )
  if (!o.stopBeforeCart) {
    // 全部选完之后 continueButton 会被换成 add-to-cart,等后者
    steps.push({ op: 'waitFor', selector: sel(autom.addToCart), timeoutMs: 20000 })
    steps.push({ op: 'click', selector: sel(autom.addToCart), label: '加入购物袋', settleMs: 600 })
  }
  const name = `Apple ${o.model}${o.screensize === '6_9inch' ? ' Max' : ''} ${o.color}/${o.capacity}`
  return { name, steps }
}

/**
 * 抢购任务的推荐参数。
 * Apple 的发售是整点放量,时钟校准的价值在这里被放到最大。
 */
const taskDefaults = {
  primeLeadMs: 8000,     // 提前 8s 预热:Apple 配置页有懒加载,给它时间稳定下来
  leadMs: 40,            // 网络提前量:国内到 Apple 中国 CDN 单程通常 15~40ms,按实测 RTT/2 填
  clockSource,
  /** 建议先人工在主机上登录、把地址和支付方式配好,再克隆 cookie 到其它实例 */
  hint: '先在主机上登录并配好收货地址与支付方式,再用「克隆登录态」把 cookie 复制到其它实例。',
}

/** 需要人工介入的信号(Apple 的排队/风控页) */
const humanNeededHints = [
  '正在排队', '稍后再试', '访问过于频繁', '验证你的身份',
  'Access Denied', 'Too Many Requests',
]

/**
 * 首发预购剧本。
 *
 * 和普通抢购的关键区别:**开售前页面上根本没有「添加到购物袋」按钮**
 * (实测 18 Pro 配置页开售前只有「继续」),所以"预热落点 + 到点开火"用不上 —— 没有落点可预热。
 * 正确姿势是提前把配置全部选好停在那儿(实测开售前就能选),
 * 然后对 add-to-cart 布下**守株待兔**:按钮一出现,页面里的观察器立刻上报,主进程当场注入。
 *
 * @returns {{playbook:object, pounce:{key:string, descriptor:object}}}
 */
function preorderPlan(opts = {}) {
  const o = { model: 'iphone-18-pro', screensize: '6_9inch', color: 'black', capacity: '256gb',
              appleCare: false, tradeIn: false, ...opts }
  // 没有尺寸这一维的机型(17 / Duo)不能带上默认的 6_9inch,否则会去等一个不存在的选项
  if (models[o.model] && !models[o.model].screensizes) o.screensize = null
  const playbook = buyPlaybook({ ...o, stopBeforeCart: true })
  return {
    playbook,
    // 守株的目标就是加购按钮本身
    pounce: {
      key: 'apple-preorder',
      descriptor: {
        tag: 'button',
        testAttr: { attr: 'data-autom', value: autom.addToCart },
        path: sel(autom.addToCart),
        text: '添加到购物袋',
        offset: { x: 0.5, y: 0.5 },
        size: null,
      },
    },
    preorderAt: (models[o.model] && models[o.model].preorder) ? models[o.model].preorder.at : null,
  }
}

module.exports = {
  id: 'apple-cn',
  models,
  preorderPlan,
  name: 'Apple 中国大陆',
  origin: ORIGIN,
  profileDefaults,
  clockSource,
  urls,
  autom,
  sel,
  buyPlaybook,
  taskDefaults,
  humanNeededHints,
}
