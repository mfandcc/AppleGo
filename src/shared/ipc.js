'use strict'
/**
 * IPC 契约 —— 主进程与中控渲染层共用的唯一真相。
 * 两侧都 require 这个文件,通道名写错会直接在启动时暴露,而不是运行时静默失效。
 *
 * 命名:applego:<域>:<动作>
 *   INVOKE  渲染层 -> 主进程,有返回值(ipcRenderer.invoke / ipcMain.handle)
 *   PUSH    主进程 -> 渲染层,单向推送(webContents.send / ipcRenderer.on)
 *   GUEST   主进程 <-> 被控页面的 preload,见 GuestRpc / guest.js
 */

const INVOKE = {
  /* —— 状态 —— */
  stateGet: 'applego:state:get',              // () -> AppState

  /* —— 实例 —— */
  instanceCreate: 'applego:instance:create',  // ({count?, profileId?, url?}) -> Instance[]
  instanceRemove: 'applego:instance:remove',  // ({id}) -> {ok}
  instanceUpdate: 'applego:instance:update',  // ({id, patch}) -> Instance
  instanceNavigate: 'applego:instance:navigate', // ({id|'all'|'slaves', url}) -> {ok, count}
  instanceReload: 'applego:instance:reload',  // ({id|'all'}) -> {ok, count}
  instanceSetMaster: 'applego:instance:set-master', // ({id}) -> {ok}
  instanceFocus: 'applego:instance:focus',    // ({id|null}) -> {ok}   null = 退出焦点模式
  instanceReset: 'applego:instance:reset',    // ({id, keepCookies}) -> {ok}
  instanceCloneCookies: 'applego:instance:clone-cookies', // ({from, to:[]}) -> {ok}
  instanceDevtools: 'applego:instance:devtools', // ({id}) -> {ok}

  /* —— 标签页 —— */
  tabCreate: 'applego:tab:create',            // ({instanceId, url}) -> Tab
  tabClose: 'applego:tab:close',              // ({instanceId, tabId}) -> {ok}
  tabActivate: 'applego:tab:activate',        // ({instanceId, tabId}) -> {ok}

  /* —— 同步 —— */
  syncSet: 'applego:sync:set',                // ({enabled?, mode?, allowTextKeys?, hover?}) -> SyncState
  syncPrime: 'applego:sync:prime',            // ({key, descriptor?}) -> results[]
  syncFire: 'applego:sync:fire',              // ({key, verify?}) -> record
  syncArm: 'applego:sync:arm',                // ({key, descriptor, targets?}) -> 守株待兔布防
  syncDisarm: 'applego:sync:disarm',          // ({key}) -> {ok}
  syncPounceStatus: 'applego:sync:pounce-status', // ({key}) -> {armedAt, hits}

  /* —— 布局:渲染层量好格子,主进程照抄给原生 view —— */
  layoutRects: 'applego:layout:rects',        // ({rects:[{id,x,y,w,h,visible}], dpr}) -> {ok}
  layoutSet: 'applego:layout:set',            // ({cols?:number|'auto'}) -> {ok}

  /* —— Profile —— */
  profileList: 'applego:profile:list',        // () -> Profile[]
  profileSave: 'applego:profile:save',        // (Profile) -> Profile
  profileDelete: 'applego:profile:delete',    // ({id}) -> {ok}

  /* —— 任务 —— */
  taskList: 'applego:task:list',              // () -> Task[]
  taskSave: 'applego:task:save',              // (Task) -> Task
  taskDelete: 'applego:task:delete',          // ({id}) -> {ok}
  taskArm: 'applego:task:arm',                // ({id}) -> {ok, targetLocalTs}
  taskCancel: 'applego:task:cancel',          // ({id}) -> {ok}
  taskRunNow: 'applego:task:run-now',         // ({id}) -> {ok}

  /* —— 剧本 / 站点预设 —— */
  playbookRun: 'applego:playbook:run',        // ({playbook, targets, vars}) -> {ok, results}
  playbookAbort: 'applego:playbook:abort',    // ({id?}) -> {ok}
  presetList: 'applego:preset:list',          // () -> Preset[]
  presetApply: 'applego:preset:apply',        // ({presetId, options}) -> {ok}  套用环境 + 时钟源
  presetPlan: 'applego:preset:plan',          // ({presetId, options}) -> {playbook, pounce, preorderAt}

  /* —— 时钟 —— */
  clockSync: 'applego:clock:sync',            // ({url}) -> {offsetMs, uncertaintyMs, samples}
  clockGet: 'applego:clock:get',              // () -> ClockSnapshot

  /* —— 日志 —— */
  logRecent: 'applego:log:recent',            // ({n, level?, instanceId?}) -> Entry[]
  logClear: 'applego:log:clear',              // () -> {ok}
}

const PUSH = {
  state: 'applego:push:state',                // AppState 全量或增量
  instance: 'applego:push:instance',          // 单个实例变更 {id, patch}
  log: 'applego:push:log',                    // 一条日志
  syncRecord: 'applego:push:sync-record',     // 一次分发的结果
  clock: 'applego:push:clock',                // 时钟快照
  task: 'applego:push:task',                  // 任务状态变更
  toast: 'applego:push:toast',                // {level, text}
  openPanel: 'applego:push:open-panel',       // {panel} 让中控台打开某个面板(开发参数 --open= 用)
}

/** 被控页面 preload 用的通道(guest.js / GuestRpc.js) */
const GUEST = {
  ready: 'applego:guest:ready',
  event: 'applego:guest:event',
  state: 'applego:guest:state',
  role: 'applego:guest:role',
  rpc: 'applego:guest:rpc',
  rpcResult: 'applego:guest:rpc-result',
  trigger: 'applego:guest:trigger',   // 页面里挂的观察器命中目标时**主动**上报(守株待兔)
}

module.exports = { INVOKE, PUSH, GUEST }
