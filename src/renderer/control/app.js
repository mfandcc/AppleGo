/**
 * 中控台渲染层。
 *
 * 【最关键的一条架构约定】
 * 实例是原生 WebContentsView,盖在这层 HTML 之上,CSS 管不到它。
 * 所以**布局由这里的 CSS Grid 决定**:这边画好格子、量出每个格子内容区的 rect,
 * 通过 layoutRects 上报给主进程,主进程只负责把原生 view 照着这些 rect 摆好。
 * 好处是改版只改 CSS,主进程一行不用动。
 */

const api = window.applego

/* ------------------------------------------------------------------ 状态 */

const state = {
  view: 'stage',
  instances: [],
  sync: { enabled: false, mode: 'auto', masterId: null, allowTextKeys: false, hover: true },
  clock: { synced: false, offsetMs: 0, uncertaintyMs: null },
  tasks: [],
  nextTask: null,
  events: [],
  latency: [],
  lastDispatch: null,
  layout: { cols: 'auto' },
  focusedId: null,
  /** 当前打开的浮层数量。>0 时实例 view 必须收起来,否则会盖住浮层。 */
  overlayDepth: 0,
}

const $ = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k === 'html') n.innerHTML = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v != null && v !== false) n.setAttribute(k, v)
  }
  for (const kid of kids.flat()) { if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid)) }
  return n
}

const STATUS_TEXT = { idle: '空闲', loading: '加载中', ready: '就绪', error: '错误', 'needs-human': '待人工' }

/**
 * 抢购时间一律以**目标站所在时区**为准来显示。
 *
 * 这台机器可能根本不在中国(实测本机是 America/Los_Angeles)。
 * 用 toLocaleString 的默认时区,北京时间 9/12 20:00 会显示成 9/12 05:00 —— 照着这个等就直接错过开售。
 * 所以主显北京时间,括号里附本机时间,两边都标清楚。
 */
const { parseBeijing, fmtSiteTime, localTz, SITE_TZ } = globalThis.AppleGoTime
const LOCAL_TZ = localTz()

const STATUS_CHIP = { idle: 'ghost', loading: 'soft-info', ready: 'soft-ok', error: 'solid-danger', 'needs-human': 'solid-warn' }

/* ------------------------------------------------------------------ 舞台网格 */

function gridColumns(n) {
  if (state.layout.cols !== 'auto') return Number(state.layout.cols)
  if (n <= 1) return 1
  if (n <= 4) return 2
  if (n <= 9) return 3
  if (n <= 16) return 4
  if (n <= 25) return 5
  return 6
}

function renderStage() {
  const stage = $('#stage')
  const list = state.instances
  if (!list.length) {
    stage.style.gridTemplateColumns = '1fr'
    stage.replaceChildren(el('div', { class: 'card' },
      el('div', { class: 'empty' },
        el('div', { html: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>' }),
        '还没有实例', el('button', { class: 'btn primary', onclick: addInstance }, '新增第一个实例'))))
    pushRects()
    return
  }

  // 焦点模式:一个大格 + 其余缩略;否则均匀网格
  const focused = state.focusedId != null ? list.find(i => i.id === state.focusedId) : null
  stage.style.gridTemplateColumns = focused
    ? `2.6fr repeat(${Math.min(3, Math.max(1, list.length - 1))}, 1fr)`
    : `repeat(${gridColumns(list.length)}, 1fr)`

  const ordered = focused ? [focused, ...list.filter(i => i.id !== focused.id)] : list
  const frag = document.createDocumentFragment()
  for (const inst of ordered) frag.append(cellBox(inst, focused && inst.id === focused.id))
  stage.replaceChildren(frag)
  pushRects()
}

function cellBox(inst, isBig) {
  const cls = ['cellbox']
  if (inst.id === state.sync.masterId) cls.push('is-master')
  if (inst.status === 'needs-human') cls.push('needs-human')
  if (inst.enabled === false) cls.push('disabled')

  const box = el('div', { class: cls.join(' '), 'data-id': inst.id, style: isBig ? 'grid-row: span 2' : null },
    el('div', { class: 'cell-head' },
      el('span', { class: 'dot ' + (inst.status || 'idle') }),
      el('span', { class: 'name' }, inst.name || ('实例 ' + inst.id)),
      inst.id === state.sync.masterId ? el('span', { class: 'chip master' }, '主控') : null,
      el('span', { class: 'url' }, inst.url || '空白页'),
      el('span', { class: 'acts' },
        iconBtn('设为主机', 'M5 12h14M13 6l6 6-6 6', () => api.instanceSetMaster({ id: inst.id })),
        iconBtn('重载', 'M20 11a8 8 0 1 0-2.3 6.1M20 4.5V11h-6.5', () => api.instanceReload({ id: inst.id })),
        iconBtn(state.focusedId === inst.id ? '退出放大' : '放大', 'M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5',
          () => { state.focusedId = state.focusedId === inst.id ? null : inst.id; api.instanceFocus({ id: state.focusedId }); renderStage() }),
        iconBtn('关闭', 'M6 6l12 12M18 6L6 18', () => api.instanceRemove({ id: inst.id })))),
    el('div', { class: 'cell-body', 'data-cell': inst.id },
      inst.url ? null : el('div', { class: 'cell-placeholder' }, '空白页')))
  return box
}

function iconBtn(title, d, onclick) {
  return el('button', { title, onclick },
    el('span', { html: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${d}"/></svg>` }))
}

/* —— 量格子并上报。这是原生 view 唯一的位置来源 —— */
let rectTimer = null
function pushRects() {
  if (rectTimer) cancelAnimationFrame(rectTimer)
  rectTimer = requestAnimationFrame(() => {
    rectTimer = null

    // 实例是原生 WebContentsView,层级永远在这层 HTML 之上,z-index 对它无效。
    // 所以只要有浮层(弹窗/下拉面板)打开,就必须把所有 view 收起来,
    // 否则弹窗会被实例画面整块盖住、点都点不到。
    // 收起来不影响实例运行:实测 #6,setVisible(false) 的 view 照样能收输入、照样能测 DOM。
    if (state.overlayDepth > 0) {
      api.layoutRects({ rects: $$('[data-cell]').map(n => ({ id: Number(n.dataset.cell), x: 0, y: 0, w: 0, h: 0, visible: false })), dpr: window.devicePixelRatio })
      return
    }

    const rects = $$('[data-cell]').map(node => {
      const r = node.getBoundingClientRect()
      return {
        id: Number(node.dataset.cell),
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        // 完全滚出可视区的格子让主进程把 view 隐藏掉 —— 实测 #6:隐藏了照样能同步
        visible: r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight,
      }
    })
    api.layoutRects({ rects, dpr: window.devicePixelRatio })
  })
}

window.addEventListener('resize', pushRects)
new ResizeObserver(pushRects).observe(document.body)

/* ------------------------------------------------------------------ 其它区块 */

function renderKpis() {
  const list = state.instances
  const ready = list.filter(i => i.status === 'ready').length
  const human = list.filter(i => i.status === 'needs-human').length
  const c = state.clock
  $('#kpis').replaceChildren(
    kpi('实例', `${list.length}`),
    kpi('就绪', `${ready}`, ready < list.length ? 'var(--warn)' : null),
    kpi('待人工', `${human}`, human ? 'var(--warn)' : null),
    kpi('时钟偏移', c.synced ? `${c.offsetMs > 0 ? '+' : ''}${c.offsetMs}` : '—', null, c.synced ? 'ms' : null),
  )
}

function kpi(label, value, color, unit) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'value mono', style: color ? `color:${color}` : null },
      value, unit ? el('span', { class: 'unit' }, unit) : null))
}

function renderTable() {
  const tb = $('#instTable tbody')
  if (!state.instances.length) {
    tb.replaceChildren(el('tr', {}, el('td', { colspan: 9 }, el('div', { class: 'hint', style: 'padding:14px 0' }, '暂无实例'))))
    $('#instSummary').textContent = ''
    return
  }
  tb.replaceChildren(...state.instances.map(inst => {
    const isMaster = inst.id === state.sync.masterId
    return el('tr', { class: isMaster ? 'is-master' : '' },
      el('td', {}, el('span', { class: 'dot ' + (inst.status || 'idle') })),
      el('td', {}, inst.name || ('实例 ' + inst.id)),
      el('td', {}, isMaster ? el('span', { class: 'chip master' }, '主控') : el('span', { class: 'chip ghost' }, '从')),
      el('td', {}, el('span', { class: 'chip ' + (STATUS_CHIP[inst.status] || 'ghost') }, STATUS_TEXT[inst.status] || '空闲')),
      el('td', { class: 'mono', style: 'font-size:11.5px' }, inst.proxyLabel || '直连'),
      el('td', { style: 'font-size:12px' }, inst.timezone || '跟随系统'),
      el('td', { class: 'mono' }, inst.lastSyncMs != null ? inst.lastSyncMs + 'ms' : '—'),
      el('td', { class: 'grow', style: 'font-size:12px;color:var(--ink-3)' }, inst.url || '—'),
      el('td', {},
        el('div', { style: 'display:flex;gap:4px;justify-content:flex-end' },
          el('button', { class: 'btn sm', onclick: () => api.instanceSetMaster({ id: inst.id }) }, '主控'),
          el('button', { class: 'btn sm', onclick: () => api.instanceDevtools({ id: inst.id }) }, 'DT'))))
  }))
  const ready = state.instances.filter(i => i.status === 'ready').length
  $('#instSummary').textContent = `${ready}/${state.instances.length} 就绪`
}

function renderAlerts() {
  const bad = state.instances.filter(i => i.status === 'needs-human' || i.status === 'error')
  $('#alertCount').textContent = String(bad.length)
  $('#alertCount').className = 'chip ' + (bad.length ? 'solid-warn' : 'ghost')
  const badge = $('#railAlerts').querySelector('.badge')
  if (bad.length) {
    if (badge) badge.textContent = bad.length
    else $('#railAlerts').append(el('span', { class: 'badge' }, String(bad.length)))
  } else if (badge) badge.remove()

  const host = $('#alerts')
  if (!bad.length) { host.replaceChildren(el('div', { class: 'empty' }, '一切正常')); return }
  host.replaceChildren(...bad.map(inst => el('div', { class: 'alert-row' },
    el('div', { class: 'txt' },
      el('div', { class: 't1' },
        inst.name || ('实例 ' + inst.id),
        el('span', { class: 'chip ' + (inst.status === 'error' ? 'solid-danger' : 'solid-warn') },
          inst.status === 'error' ? '错误' : '待人工')),
      el('div', { class: 't2' }, inst.statusHint || inst.url || '—')),
    el('button', { class: 'btn sm', onclick: () => { state.focusedId = inst.id; api.instanceFocus({ id: inst.id }); renderStage() } }, '去处理'))))
}

function renderEvents() {
  const host = $('#events')
  host.replaceChildren(...state.events.slice(-120).reverse().map(e => el('div', { class: 'evt ' + e.level },
    el('span', { class: 't mono' }, new Date(e.ts).toTimeString().slice(0, 8)),
    el('span', { class: 'm' }, (e.data && e.data.instanceId != null ? `#${e.data.instanceId} ` : '') + e.msg))))
}

function renderSpark() {
  const pts = state.latency.slice(-60)
  const svg = $('#spark')
  if (pts.length < 2) { svg.replaceChildren(); $('#latencyNow').textContent = '—'; return }
  const max = Math.max(20, ...pts)
  const step = 300 / (pts.length - 1)
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(46 - (v / max) * 42).toFixed(1)}`).join(' ')
  svg.innerHTML =
    `<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0%" stop-color="var(--chart-1)" stop-opacity=".55"/>
       <stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0"/></linearGradient></defs>
     <path d="${d} L300,46 L0,46 Z" fill="url(#sg)"/>
     <path d="${d}" fill="none" stroke="var(--chart-1)" stroke-width="1.6"/>`
  $('#latencyNow').textContent = pts[pts.length - 1] + ' ms'
}

/**
 * 注入 ≠ 生效。
 * sendInputEvent 不抛错只说明事件发出去了,弹窗盖住、按钮 disabled、元素重排走了都会静默落空。
 * 这里必须把两个数分开显示,否则会出现"全绿但一单没成"。
 */
function renderHitRate() {
  const rec = state.lastDispatch
  const host = $('#hitRate')
  if (!host) return
  if (!rec) { host.textContent = '—'; host.className = 'hint mono'; return }
  const hasOutcome = rec.effected != null
  host.textContent = hasOutcome ? `注入 ${rec.ok}/${rec.total} · 生效 ${rec.effected}/${rec.total}` : `注入 ${rec.ok}/${rec.total} · 核对中…`
  const bad = hasOutcome && rec.effected < rec.ok
  host.className = 'hint mono' + (bad ? ' warnish' : '')
  host.style.color = bad ? 'var(--warn)' : ''
  const st = $('#stHit')
  if (st) st.textContent = hasOutcome ? `命中 ${rec.effected}/${rec.total}` : `注入 ${rec.ok}/${rec.total}`
}

function renderSync() {
  const on = state.sync.enabled
  const pill = $('#btnSync')
  pill.className = 'live-pill' + (on ? '' : ' off')
  $('#syncLabel').textContent = on ? `同步中 · ${modeLabel(state.sync.mode)}` : '同步已停止'
  $('#selMode').value = state.sync.mode
  $('#chkTextKeys').checked = !!state.sync.allowTextKeys
  $('#chkHover').checked = state.sync.hover !== false
  $('#stSync').textContent = on ? `同步 ${modeLabel(state.sync.mode)}` : '同步 关闭'
}

const modeLabel = m => ({ auto: '智能', semantic: '语义', coordinate: '坐标' })[m] || m

function renderClock() {
  const c = state.clock
  $('#stClock').textContent = c.synced
    ? `时钟 ${c.offsetMs > 0 ? '+' : ''}${c.offsetMs}ms ±${c.uncertaintyMs}ms`
    : '时钟未校准'
}

function renderCountdown() {
  const t = state.nextTask
  if (!t) { $('#countdown').textContent = '--:--:--'; $('#countdown').className = 'countdown mono'; $('#taskName').textContent = '—'; $('#taskMeta').textContent = '暂无待执行任务'; return }
  const remain = Math.max(0, t.atServerTs - (Date.now() + state.clock.offsetMs))
  const h = String(Math.floor(remain / 3600000)).padStart(2, '0')
  const m = String(Math.floor(remain / 60000) % 60).padStart(2, '0')
  const s = String(Math.floor(remain / 1000) % 60).padStart(2, '0')
  const ms = String(Math.floor(remain % 1000)).padStart(3, '0')
  $('#countdown').textContent = remain < 60000 ? `${s}.${ms}` : `${h}:${m}:${s}`
  $('#countdown').className = 'countdown mono' + (remain < 30000 ? ' hot' : '')
  $('#taskName').textContent = t.name || '未命名任务'
  $('#taskMeta').textContent = `${t.targetCount || 0} 个实例 · ${fmtSiteTime(t.atServerTs)}`
}
setInterval(renderCountdown, 53)

function renderAll() {
  renderKpis(); renderStage(); renderTable(); renderAlerts(); renderSync(); renderClock(); renderSpark(); renderHitRate()
  $('#stInstances').textContent = `实例 ${state.instances.length}`
}

/* ------------------------------------------------------------------ 动作 */

async function addInstance() {
  await api.instanceCreate({ count: 1 })
}

function wireUi() {
  $('#btnAddInstance').onclick = addInstance
  $('#btnReloadAll').onclick = () => api.instanceReload({ id: 'all' })
  $('#btnSync').onclick = () => api.syncSet({ enabled: !state.sync.enabled })
  $('#selMode').onchange = e => api.syncSet({ mode: e.target.value })
  $('#chkTextKeys').onchange = e => api.syncSet({ allowTextKeys: e.target.checked })
  $('#chkHover').onchange = e => api.syncSet({ hover: e.target.checked })
  $('#selLayout').onchange = e => { state.layout.cols = e.target.value; renderStage() }
  $('#btnClearLog').onclick = async () => { await api.logClear(); state.events = []; renderEvents() }
  $('#btnClockSync').onclick = async () => {
    const url = prompt('对哪个地址校准时钟?(取它响应头里的 Date)', 'https://www.apple.com.cn/')
    if (url) await api.clockSync({ url })
  }
  $('#omniInput').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return
    const url = normalizeUrl(e.target.value)
    if (url) api.instanceNavigate({ id: 'all', url })
  })
  $('#omniGoMaster').onclick = () => {
    const url = normalizeUrl($('#omniInput').value)
    if (url && state.sync.masterId != null) api.instanceNavigate({ id: state.sync.masterId, url })
  }
  $$('#rail .rail-btn').forEach(btn => {
    btn.onclick = () => {
      $$('#rail .rail-btn').forEach(b => b.classList.toggle('active', b === btn))
      state.view = btn.dataset.view
      $('#pageTitle').textContent = { stage: '舞台', instances: '实例', profiles: '环境', tasks: '任务', logs: '日志', alerts: '告警', settings: '设置' }[state.view] || '舞台'
      $('#crumbs').innerHTML = `AppleGo <b>›</b> ${$('#pageTitle').textContent}`
    }
  })
  $('#btnNewTask').onclick = () => openTaskModal()
  $('#btnApple').onclick = () => openAppleModal()
}

function normalizeUrl(v) {
  const s = String(v || '').trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return 'https://' + s
  return 'https://www.baidu.com/s?wd=' + encodeURIComponent(s)
}

/* ------------------------------------------------------------------ 浮层 */

/**
 * 打开一个浮层。
 *
 * 必须走这个入口,不要直接往 #modalHost 里塞东西 ——
 * 原生实例 view 的层级在中控 UI 之上,不收起来的话浮层会被盖住(实测过:只剩边角能点)。
 * 返回的 close 会把 view 放回来。
 */
function openOverlay(build) {
  const host = $('#modalHost')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    state.overlayDepth = Math.max(0, state.overlayDepth - 1)
    host.replaceChildren()
    pushRects()                 // 把实例 view 放回来
  }
  state.overlayDepth++
  pushRects()                   // 先收起 view,再渲染浮层
  host.replaceChildren(build(close))
  // Esc 关闭
  const onKey = e => { if (e.key === 'Escape') { close(); window.removeEventListener('keydown', onKey) } }
  window.addEventListener('keydown', onKey)
  return close
}

/* ------------------------------------------------------------------ 任务弹窗 */

function openTaskModal(task) {
  const t = task || { name: '', url: '', at: '', selector: '', primeLeadMs: 5000, leadMs: 40, targets: 'all' }
  openOverlay(close => el('div', { class: 'scrim', onclick: e => { if (e.target.classList.contains('scrim')) close() } },
    el('div', { class: 'modal' },
      el('h2', {}, '新建抢购任务'),
      field('任务名', el('input', { id: 'f_name', value: t.name, placeholder: '例如:10点整抢限量款' })),
      field('开抢前先打开的页面(可留空)', el('input', { id: 'f_url', value: t.url, placeholder: 'https://…' })),
      field(`开抢时刻(按北京时间填,本机时区是 ${LOCAL_TZ})`,
        el('input', { id: 'f_at', type: 'datetime-local', value: t.at, oninput: e => {
          const hint = $('#f_at_hint')
          const ms = parseBeijing(e.target.value)
          if (hint) hint.textContent = ms ? '= ' + fmtSiteTime(ms) : ''
        } })),
      el('div', { class: 'hint', id: 'f_at_hint', style: 'color:var(--ink-dark-2);margin:-6px 0 8px' }),
      field('要点的元素(CSS 选择器)', el('input', { id: 'f_sel', value: t.selector, placeholder: '#buy-now, .btn-buy' })),
      el('div', { class: 'row2' },
        field('提前多久预热(毫秒)', el('input', { id: 'f_prime', type: 'number', value: t.primeLeadMs })),
        field('提前量补偿(毫秒)', el('input', { id: 'f_lead', type: 'number', value: t.leadMs }))),
      el('div', { class: 'hint', style: 'color:var(--ink-dark-2);margin-top:4px' },
        '预热会在开抢前把目标元素在每个实例里先定位好;到点只剩一次输入注入(实测约 9μs)。'),
      el('footer', {},
        el('button', { class: 'btn', onclick: close }, '取消'),
        el('button', { class: 'btn solid', onclick: async () => {
          const payload = {
            name: $('#f_name').value || '未命名任务',
            url: $('#f_url').value || null,
            // 输入框里填的是北京时间,不能让浏览器按本机时区去解释
            atServerTs: parseBeijing($('#f_at').value),
            selector: $('#f_sel').value,
            primeLeadMs: Number($('#f_prime').value) || 5000,
            leadMs: Number($('#f_lead').value) || 0,
            targets: 'all',
          }
          if (!payload.atServerTs || Number.isNaN(payload.atServerTs)) { alert('请填开抢时刻'); return }
          const saved = await api.taskSave(payload)
          if (saved && saved.id) await api.taskArm({ id: saved.id })
          close()
        } }, '保存并布防')))))
}

function field(label, input) {
  return el('div', { class: 'field' }, el('label', {}, label), input)
}

/* ------------------------------------------------------------------ Apple 中国抢购 */

/**
 * Apple 面板。
 *
 * 机型 / 尺寸 / 颜色 / 容量全部来自主进程下发的 preset(即 apple-cn.js 里那份在实站上枚举出来的表),
 * UI 这边不再抄一份,免得两边对不上。
 *
 * 首发预购和日常抢购是两种打法,面板里分开:
 *   日常:元素本来就在 → 配置完直接加购,或预热落点等定时器开火
 *   首发:**开售前根本没有加购按钮** → 提前把配置选好停住,再对加购按钮布下守株待兔,
 *        按钮一出现页面里的观察器立刻上报、主进程当场注入(实测 5ms)
 */
let applePreset = null

async function ensurePreset() {
  if (applePreset) return applePreset
  const list = await api.presetList()
  applePreset = (list || []).find(x => x.id === 'apple-cn') || null
  return applePreset
}

function openAppleModal() {
  ensurePreset().then(preset => {
    const models = (preset && preset.models) || {}
    const modelKeys = Object.keys(models)
    if (!modelKeys.length) { alert('预设未加载'); return }

    openOverlay(close => {
      const opt = (v, t) => el('option', { value: v }, t || v)
      const modelSel = el('select', { id: 'a_model' }, ...modelKeys.map(k => opt(k, models[k].title || k)))
      const ssWrap = el('div', { class: 'field', id: 'a_ss_wrap' })
      const colorSel = el('select', { id: 'a_color' })
      const capSel = el('select', { id: 'a_cap' })
      const info = el('div', { class: 'hint', id: 'a_info', style: 'color:var(--ink-dark-2);margin:-4px 0 10px' })
      const resultBox = el('div', { id: 'a_result', style: 'margin-top:12px;max-height:160px;overflow:auto' })

      const syncOptions = () => {
        const m = models[modelSel.value] || {}
        colorSel.replaceChildren(...(m.colors || []).map(c => opt(c.v, c.t)))
        capSel.replaceChildren(...(m.capacities || []).map(c => opt(c.v, c.t)))
        ssWrap.replaceChildren()
        if (m.screensizes) {
          // 这一维只有部分机型有(18 Pro 靠它区分 Pro / Pro Max),没有就不显示
          ssWrap.append(el('label', {}, '机身尺寸'),
            el('select', { id: 'a_ss' }, ...m.screensizes.map(x => opt(x.v, x.t))))
          const sel = ssWrap.querySelector('select')
          if (m.screensizes.some(x => x.v === '6_9inch')) sel.value = '6_9inch'
        }
        const po = m.preorder
        info.textContent = po
          ? `首发预购:${fmtSiteTime(po.at)} 开始 · ${po.release} 发售 · 每人限购 ${po.limitPerCustomer} 部`
          : '常规在售机型'
        $('#a_preorder') && ($('#a_preorder').disabled = !po)
      }
      modelSel.onchange = syncOptions

      const opts = () => ({
        model: modelSel.value,
        screensize: ssWrap.querySelector('select') ? ssWrap.querySelector('select').value : null,
        color: colorSel.value,
        capacity: capSel.value,
        appleCare: $('#a_ac').checked,
        tradeIn: $('#a_ti').checked,
      })

      const report = lines => resultBox.replaceChildren(...lines.map(l =>
        el('div', { class: 'evt ' + (l.bad ? 'error' : '') },
          el('span', { class: 't mono' }, l.tag || ''), el('span', { class: 'm' }, l.text))))

      const runConfigure = async (stopBeforeCart) => {
        const btn = $(stopBeforeCart ? '#a_preorder' : '#a_buy')
        const old = btn.textContent
        btn.disabled = true; btn.textContent = '执行中…'
        try {
          const plan = await api.presetPlan({ presetId: 'apple-cn', options: opts() })
          if (!plan || !plan.ok) { report([{ text: '生成方案失败', bad: true }]); return }
          const playbook = stopBeforeCart ? plan.playbook : {
            name: plan.playbook.name,
            steps: plan.playbook.steps.concat([
              { op: 'waitFor', selector: '[data-autom="add-to-cart"]', timeoutMs: 20000 },
              { op: 'click', selector: '[data-autom="add-to-cart"]', label: '加入购物袋', settleMs: 600 },
            ]),
          }
          const res = await api.playbookRun({ playbook, targets: 'all' })
          report((res.results || []).map(r => ({
            tag: '#' + r.instanceId,
            text: r.ok ? '✓ 配置完成' : `✗ 第 ${(r.failedAt ?? 0) + 1} 步 ${r.step || ''} — ${r.reason}`,
            bad: !r.ok,
          })))
          if (stopBeforeCart && res.ok > 0) {
            const armed = await api.syncArm({ key: plan.pounce.key, descriptor: plan.pounce.descriptor, targets: 'all' })
            report([{ text: `已配置 ${res.ok}/${res.total} 个实例,并对「添加到购物袋」布下守株待兔 —— 按钮一出现即自动点击` }]
              .concat((armed || []).filter(a => !a.ok).map(a => ({ tag: '#' + a.instanceId, text: '布防失败 ' + a.reason, bad: true }))))
          }
        } finally { btn.disabled = false; btn.textContent = old }
      }

      const node = el('div', { class: 'scrim', onclick: e => { if (e.target.classList.contains('scrim')) close() } },
        el('div', { class: 'modal', style: 'width:min(660px,93vw)' },
          el('h2', {}, 'Apple 中国大陆 · 抢购'),
          el('div', { class: 'hint', style: 'color:var(--ink-dark-2);margin:-8px 0 14px' },
            '机型与选项取自 apple.com.cn 实时 DOM 的 data-autom 属性,按所选参数自动拼出。'),

          el('div', { class: 'row2' }, field('机型', modelSel), ssWrap),
          el('div', { class: 'row2' }, field('颜色', colorSel), field('容量', capSel)),
          field('选项', el('div', { style: 'display:flex;gap:14px;align-items:center;height:36px' },
            el('label', { style: 'display:flex;gap:6px;align-items:center' }, el('input', { type: 'checkbox', id: 'a_ac' }), 'AppleCare+'),
            el('label', { style: 'display:flex;gap:6px;align-items:center' }, el('input', { type: 'checkbox', id: 'a_ti' }), '换购折抵'))),
          info,

          el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px' },
            el('button', { class: 'btn', onclick: async () => {
              const r = await api.presetApply({ presetId: 'apple-cn', targets: 'all' })
              report([{ text: r && r.ok ? `已把环境套到 ${r.applied} 个实例,并按 apple.com.cn 对表` : '套用失败', bad: !(r && r.ok) }])
            } }, '① 套环境 + 对表'),
            el('button', { class: 'btn', onclick: () => api.instanceNavigate({ id: 'all', url: (preset.urls && preset.urls.signIn) || 'https://www.apple.com.cn/shop/signIn' }) }, '② 全部去登录'),
            el('button', { class: 'btn', onclick: async () => {
              if (state.sync.masterId == null) return
              const r = await api.instanceCloneCookies({ from: state.sync.masterId })
              report([{ text: r && r.ok ? '已把主机登录态克隆到其余实例' : '克隆失败', bad: !(r && r.ok) }])
            } }, '③ 克隆主机登录态')),

          el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
            el('button', { class: 'btn solid', id: 'a_preorder', onclick: () => runConfigure(true) }, '④ 首发预购:配好并守株待兔'),
            el('button', { class: 'btn', id: 'a_buy', onclick: () => runConfigure(false) }, '立即加入购物袋(已开售时用)')),

          resultBox,

          el('div', { class: 'hint', style: 'color:var(--ink-dark-2);margin-top:12px;line-height:1.7' },
            '首发当天:开售前页面上没有「添加到购物袋」按钮,所以④ 会先把配置全部选好停住,' +
            '再在每个实例页面里挂观察器 —— 按钮一出现就地点击,实测 5ms。' +
            '遇到验证码或排队页,该实例会标成「待人工」并在右侧告警,请手动处理;本工具不做验证码绕过。' +
            '请自行遵守 Apple 的销售条款与限购规则。'),

          el('footer', {}, el('button', { class: 'btn', onclick: close }, '关闭')))
      )
      // 先挂进 DOM 再填选项,syncOptions 里要用 $('#a_preorder')
      setTimeout(syncOptions, 0)
      return node
    })
  })
}

/* ------------------------------------------------------------------ 启动 */

function applyState(s) {
  Object.assign(state, s)
  renderAll()
}

async function boot() {
  // 先把平台标到根元素上,CSS 据此给窗口控件让位 —— 必须在首帧之前做,否则会看到一次跳动
  const plat = (api.platform && api.platform.os) || 'unknown'
  document.documentElement.dataset.platform = plat
  document.documentElement.dataset.windowControls =
    api.platform && api.platform.isMac ? 'left' : 'right'

  wireUi()
  const v = api.platform && api.platform.versions
  $('#stVersion').textContent = v ? `v0.1.0 · Electron ${v.electron}` : 'v0.1.0'

  api.on('state', applyState)
  api.on('instance', ({ id, patch }) => {
    const i = state.instances.find(x => x.id === id)
    if (!i) return
    Object.assign(i, patch)
    renderTable(); renderAlerts(); renderKpis()
    // 主控/状态变了要重画格子边框
    if ('status' in patch || 'name' in patch || 'url' in patch) renderStage()
  })
  api.on('log', e => { state.events.push(e); if (state.events.length > 500) state.events.shift(); renderEvents() })
  api.on('syncRecord', rec => {
    // 同一条记录会推两次:注入完一次,核对完再一次(带 effected)。
    // 只有第一次才计入延迟曲线,否则曲线会被重复点污染。
    if (state.lastDispatch && state.lastDispatch.seq === rec.seq) {
      state.lastDispatch = rec
      renderHitRate()
      return
    }
    state.lastDispatch = rec
    state.latency.push(rec.latencyMs)
    if (state.latency.length > 200) state.latency.shift()
    renderSpark(); renderHitRate()
  })
  api.on('clock', c => { state.clock = c; renderClock(); renderKpis() })
  api.on('task', t => { state.nextTask = t; renderCountdown() })
  api.on('openPanel', ({ panel }) => { if (panel === 'apple') openAppleModal(); else if (panel === 'task') openTaskModal() })

  applyState(await api.stateGet())
  state.events = await api.logRecent({ n: 120 })
  renderEvents()
}

boot().catch(err => {
  document.body.append(el('div', { class: 'scrim' }, el('div', { class: 'modal' },
    el('h2', {}, '中控台启动失败'), el('pre', {}, String(err && err.stack || err)))))
})
