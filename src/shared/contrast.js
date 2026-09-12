'use strict'
/**
 * 对比度计算(WCAG 2.1 相对亮度)。
 *
 * 存在的理由:AppleGo 的底色是一条从石板蓝到晨雾白的垂直渐变,
 * 同一个颜色的文字放在界面上半部和下半部,可读性天差地别。
 * 靠肉眼调色调不准 —— 原来那套配色实测下来,白色小字只在顶部 3% 内过得了 4.5:1,
 * 5%~43% 是个死区(白字深字都不够)。所以配色必须是**算出来**的,并且能被测试钉住。
 */

/** '#RRGGBB' 或 '#RGB' -> [r,g,b] */
function hexToRgb(hex) {
  const h = String(hex).replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
}

/** WCAG 相对亮度 */
function luminance(rgb) {
  const f = c => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

/** 两个颜色的对比度(1~21) */
function contrast(a, b) {
  const l1 = Array.isArray(a) ? luminance(a) : a
  const l2 = Array.isArray(b) ? luminance(b) : b
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

/** 把前景色按 alpha 合成到背景上 */
function composite(bg, fg, alpha) {
  return bg.map((v, i) => v * (1 - alpha) + fg[i] * alpha)
}

/** 线性渐变在位置 p(0~1)处的颜色。stops: [[pos, '#hex'], ...] */
function gradientAt(stops, p) {
  const q = Math.min(1, Math.max(0, p))
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, h0] = stops[i]
    const [p1, h1] = stops[i + 1]
    if (q >= p0 && q <= p1) {
      const t = p1 === p0 ? 0 : (q - p0) / (p1 - p0)
      const c0 = hexToRgb(h0), c1 = hexToRgb(h1)
      return c0.map((v, j) => v + (c1[j] - v) * t)
    }
  }
  return hexToRgb(stops[stops.length - 1][1])
}

/** WCAG 门槛:大字(>=24px,或 >=18.66px 且粗体)3:1,其余 4.5:1 */
function required(fontSizePx, fontWeight) {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && (fontWeight || 400) >= 700)
  return large ? 3 : 4.5
}

module.exports = { hexToRgb, luminance, contrast, composite, gradientAt, required }
