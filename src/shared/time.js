'use strict'
/**
 * 抢购时间处理。
 *
 * 这个文件存在的唯一理由:**跑这个工具的机器不一定在目标站所在的时区。**
 * 实测本机是 America/Los_Angeles,而抢的是 apple.com.cn。
 * 北京时间 2026-09-12 20:00 在本机显示是 09-12 05:00 —— 任何一处用了 `new Date(str)`
 * 或默认时区的 toLocaleString,都会让人整整差 15 小时,直接错过开售。
 *
 * 所以:输入一律按站点时区解析,显示一律主显站点时区、附本机时间。
 */

/** 中国全年 UTC+8,无夏令时,可以硬编码 */
const CN_OFFSET_MIN = 8 * 60
const SITE_TZ = 'Asia/Shanghai'

/**
 * 把 `<input type="datetime-local">` 的值当作**北京时间**解析成时间戳。
 * 直接 `new Date(v)` 会按本机时区解释,这正是要避免的。
 * @param {string} v 形如 "2026-09-12T20:00" 或 "2026-09-12T20:00:00"
 * @returns {number} 毫秒时间戳;无法解析返回 NaN
 */
function parseBeijing(v) {
  if (typeof v !== 'string') return NaN
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v.trim())
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - CN_OFFSET_MIN * 60_000
}

/** 时间戳 -> 可填回 datetime-local 的北京时间字符串 */
function toBeijingInput(ts) {
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts + CN_OFFSET_MIN * 60_000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 本机时区名 */
function localTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch (e) { return 'unknown' }
}

/**
 * 显示用:主显北京时间,本机时区不同时附上本机时间。
 * @param {number|string} ts
 */
function fmtSiteTime(ts, { withLocal = true } = {}) {
  const d = new Date(typeof ts === 'string' ? Date.parse(ts) : ts)
  if (Number.isNaN(d.getTime())) return '—'
  const beijing = d.toLocaleString('zh-CN', { timeZone: SITE_TZ, hour12: false })
  if (!withLocal || localTz() === SITE_TZ) return `北京时间 ${beijing}`
  return `北京时间 ${beijing}(本机 ${d.toLocaleString('zh-CN', { hour12: false })})`
}

/** 倒计时拆成 {h,m,s,ms},remain<0 视为 0 */
function countdownParts(remainMs) {
  const r = Math.max(0, remainMs)
  return {
    h: Math.floor(r / 3600000),
    m: Math.floor(r / 60000) % 60,
    s: Math.floor(r / 1000) % 60,
    ms: Math.floor(r % 1000),
  }
}

const api = { parseBeijing, toBeijingInput, fmtSiteTime, localTz, countdownParts, SITE_TZ, CN_OFFSET_MIN }
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.AppleGoTime = api
