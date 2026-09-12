'use strict'
/**
 * 配色可读性的回归测试。
 *
 * 直接从 tokens.css 里读真实色值,而不是在测试里抄一份 —— 抄的那份迟早和样式表分家。
 * 渐变底色 + 半透明卡片的组合下,"看着还行"非常不可靠,所以这里把门槛写死:
 * 正文 4.5:1,大字 3:1,辅助信息(时间戳之类)3:1。
 */
const { test } = require('node:test')
const a = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const C = require('../src/shared/contrast.js')

const css = fs.readFileSync(path.join(__dirname, '../src/renderer/control/tokens.css'), 'utf8')

function token(name) {
  const m = new RegExp('--' + name + ':\\s*([^;]+);').exec(css)
  if (!m) throw new Error('tokens.css 里找不到 --' + name)
  return m[1].trim()
}
function alphaOf(rgba) {
  const m = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(rgba)
  return m ? parseFloat(m[1]) : 1
}

const GRAD = [
  [0, token('bg-0')], [0.34, token('bg-1')], [0.62, token('bg-2')],
  [0.84, token('bg-3')], [1, token('bg-4')],
]
const WHITE = [255, 255, 255]
const CARD_ALPHA = alphaOf(token('card-bg'))

/** 卡片可能出现的最高位置 —— 越高背景越深,卡片内深色文字越吃亏 */
const CARD_TOP = 0.18

test('渐变色标能被解析出来', () => {
  a.strictEqual(GRAD.length, 5)
  for (const [, hex] of GRAD) a.match(hex, /^#[0-9a-fA-F]{6}$/)
})

test('卡片底子足够厚,不能退回近乎全透明', () => {
  a.ok(CARD_ALPHA >= 0.55, `卡片 alpha 只有 ${CARD_ALPHA},文字会直接贴在渐变上`)
})

test('卡片内主文字在任何位置都 >= 4.5:1', () => {
  const ink = C.hexToRgb(token('ink-dark'))
  for (let p = CARD_TOP; p <= 1.0001; p += 0.02) {
    const card = C.composite(C.gradientAt(GRAD, p), WHITE, CARD_ALPHA)
    const c = C.contrast(ink, card)
    a.ok(c >= 4.5, `位置 ${(p * 100).toFixed(0)}% 只有 ${c.toFixed(2)}:1`)
  }
})

test('卡片内次级文字在任何位置都 >= 4.5:1', () => {
  const ink2 = C.hexToRgb(token('ink-dark-2'))
  for (let p = CARD_TOP; p <= 1.0001; p += 0.02) {
    const card = C.composite(C.gradientAt(GRAD, p), WHITE, CARD_ALPHA)
    const c = C.contrast(ink2, card)
    a.ok(c >= 4.5, `位置 ${(p * 100).toFixed(0)}% 只有 ${c.toFixed(2)}:1`)
  }
})

test('卡片内三级文字(时间戳等辅助信息)>= 3:1', () => {
  const ink3 = C.hexToRgb(token('ink-dark-3'))
  for (let p = CARD_TOP; p <= 1.0001; p += 0.02) {
    const card = C.composite(C.gradientAt(GRAD, p), WHITE, CARD_ALPHA)
    a.ok(C.contrast(ink3, card) >= 3, `位置 ${(p * 100).toFixed(0)}%`)
  }
})

test('顶部带的浅色文字在**其实际出现的最深位置**达标', () => {
  // 浅色文字只允许出现在直接贴着深色渐变的顶部带。
  // 每个 token 按它实际用到的最深处检查,而不是一刀切 —— 一刀切要么放水要么逼着把颜色调得失真。
  const cases = [
    { name: '--ink-2(KPI 标签)', token: 'ink-2', size: 12.5, deepest: 0.20 },
    { name: '--ink-3(面包屑 / KPI 单位)', token: 'ink-3', size: 14, deepest: 0.24 },
    { name: '--ink-4(搜索占位符)', token: 'ink-4', size: 14, deepest: 0.06 },
  ]
  for (const c of cases) {
    const alpha = alphaOf(token(c.token))
    const bg = C.gradientAt(GRAD, c.deepest)
    const ratio = C.contrast(C.composite(bg, WHITE, alpha), bg)
    a.ok(ratio >= C.required(c.size),
      `${c.name} 在 ${(c.deepest * 100).toFixed(0)}% 处只有 ${ratio.toFixed(2)}:1`)
  }
})

test('图标栏贯穿整条渐变,必须自带底子(非文本 3:1)', () => {
  // 图标栏从顶到底跨越全部渐变,不能靠背景本身 —— 底部浅色区会让浅色描边直接隐形
  const icon = C.hexToRgb(token('ink-dark-2'))
  for (let p = 0.05; p <= 0.92; p += 0.02) {
    const btn = C.composite(C.gradientAt(GRAD, p), WHITE, CARD_ALPHA)
    const c = C.contrast(icon, btn)
    a.ok(c >= 3, `图标栏在 ${(p * 100).toFixed(0)}% 处只有 ${c.toFixed(2)}:1`)
  }
})

test('纯白大标题在顶部达到大字门槛', () => {
  const bg = C.gradientAt(GRAD, 0.20)
  a.ok(C.contrast(WHITE, bg) >= 3, '大标题对比度不足')
})

test('语义徽章的浅底 + 深字组合达标', () => {
  const pairs = [
    ['danger-soft', 'danger-ink'], ['warn-soft', 'warn-ink'],
    ['info-soft', 'info-ink'], ['ok-soft', 'ok-ink'],
  ]
  for (const [bgT, fgT] of pairs) {
    const c = C.contrast(C.hexToRgb(token(fgT)), C.hexToRgb(token(bgT)))
    a.ok(c >= 4.5, `${fgT} on ${bgT} 只有 ${c.toFixed(2)}:1`)
  }
})

test('实心徽章的白字达标', () => {
  for (const t of ['danger', 'info']) {
    const c = C.contrast(WHITE, C.hexToRgb(token(t)))
    a.ok(c >= 3, `白字在 --${t} 上只有 ${c.toFixed(2)}:1(11px 粗体徽章,按 3:1 放宽)`)
  }
})

test('contrast 基本性质', () => {
  a.strictEqual(+C.contrast([0, 0, 0], [255, 255, 255]).toFixed(0), 21)
  a.strictEqual(+C.contrast([255, 255, 255], [255, 255, 255]).toFixed(2), 1)
  a.strictEqual(C.required(32), 3)
  a.strictEqual(C.required(20, 700), 3)
  a.strictEqual(C.required(20, 400), 4.5)
  a.strictEqual(C.required(13), 4.5)
})
