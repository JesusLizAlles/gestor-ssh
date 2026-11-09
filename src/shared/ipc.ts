import type { ServerApi } from './types'

/** Un canal IPC por método de la API; el nombre del canal es el del método. Los eventos van aparte. */
export type ApiChannel = Exclude<keyof ServerApi, 'onHostKey' | 'onTransfer' | 'onSession' | 'onUpdateState' | 'onMcpStatus' | 'onMcpActivity'>

/** Cada cambio de estado del actualizador. */
export const UPDATE_STATE_EVENT = 'updater:state'
/** El servidor presenta una huella que no conocemos: el usuario decide si fiarse. */
export const HOST_KEY_EVENT = 'ssh:host-key'
/** Cambios de estado y progreso de una transferencia. */
export const TRANSFER_EVENT = 'transfer:update'
/** Una conexión se cayó sola. */
export const SESSION_EVENT = 'ssh:session'
/** Cambios de estado del servidor MCP y cada llamada de Claude. */
export const MCP_STATUS_EVENT = 'mcp:status'
export const MCP_ACTIVITY_EVENT = 'mcp:activity'
/** El principal entrega el MessagePort de un terminal recién abierto. */
export const TERMINAL_PORT_EVENT = 'terminal:port'
/** Mensaje con el que el preload pasa ese puerto a la página (window.postMessage). */
export const TERMINAL_PORT_MESSAGE = 'gestor-ssh:terminal-port'

export const API_CHANNELS = [
  'secretStorageStatus',
  'listServers',
  'saveServer',
  'deleteServer',
  'pickPrivateKey',
  'testServer',
  'connect',
  'disconnect',
  'respondHostKey',
  'forgetHostKey',
  'listDir',
  'makeDir',
  'rename',
  'remove',
  'createFile',
  'readTextFile',
  'saveTextFile',
  'download',
  'planUpload',
  'startUpload',
  'cancelTransfer',
  'clearTransfers',
  'listTransfers',
  'showInFolder',
  'openTerminal',
  'detectModules',
  'moduleCall',
  'setSudoPassword',
  'geoipStatus',
  'geoipDownload',
  'geoipLookup',
  'updaterState',
  'checkForUpdates',
  'downloadUpdate',
  'installUpdate',
  'mcpStatus',
  'mcpSetEnabled',
  'mcpSetPort',
  'mcpRegenerateToken',
  'mcpActivity'
] as const satisfies readonly ApiChannel[]

/** Respuesta envuelta: así el mensaje de error llega limpio al renderer. */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: string }

export const channelName = (method: ApiChannel): string => `api:${method}`
