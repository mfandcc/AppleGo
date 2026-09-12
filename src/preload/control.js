'use strict'
/**
 * 中控台 preload。
 *
 * 中控 UI 不拿 Node,只拿一张白名单 API 表:
 * 通道名在这里被钉死,渲染层传什么字符串都改不了它能调到哪些能力。
 */

const { contextBridge, ipcRenderer } = require('electron')
const { INVOKE, PUSH } = require('../shared/ipc.js')

/** 把 INVOKE 表翻成 { stateGet: (payload) => Promise } */
const api = {}
for (const [name, channel] of Object.entries(INVOKE)) {
  api[name] = payload => ipcRenderer.invoke(channel, payload)
}

/** 订阅主进程推送。返回取消订阅函数。 */
api.on = (name, handler) => {
  const channel = PUSH[name]
  if (!channel) throw new Error('未知推送通道: ' + name)
  const wrapped = (_e, payload) => handler(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

api.channels = { INVOKE: Object.keys(INVOKE), PUSH: Object.keys(PUSH) }

/**
 * 平台信息。中控 UI 要据此让位给窗口控件:
 * macOS 的红绿灯在左上(图标栏要留顶部空间),Windows 的控件在右上(顶栏要留右侧空间)。
 */
api.platform = {
  os: process.platform,             // 'darwin' | 'win32' | 'linux'
  isMac: process.platform === 'darwin',
  isWindows: process.platform === 'win32',
  arch: process.arch,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
}

contextBridge.exposeInMainWorld('applego', api)
