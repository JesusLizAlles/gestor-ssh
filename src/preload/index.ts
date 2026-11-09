/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron'
import {
  API_CHANNELS,
  channelName,
  HOST_KEY_EVENT,
  SESSION_EVENT,
  TERMINAL_PORT_EVENT,
  TERMINAL_PORT_MESSAGE,
  TRANSFER_EVENT,
  type IpcEnvelope
} from '@shared/ipc'
import type { HostKeyRequest, ServerApi, SessionEvent, TransferInfo } from '@shared/types'

/** Suscripción a un evento del proceso principal; devuelve la función para darse de baja. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  ...Object.fromEntries(
    API_CHANNELS.map((method) => [
      method,
      async (...args: unknown[]) => {
        const reply = (await ipcRenderer.invoke(channelName(method), ...args)) as IpcEnvelope<unknown>
        if (!reply.ok) throw new Error(reply.error)
        return reply.value
      }
    ])
  ),
  onHostKey: (listener: (request: HostKeyRequest) => void) => subscribe(HOST_KEY_EVENT, listener),
  onTransfer: (listener: (transfer: TransferInfo) => void) => subscribe(TRANSFER_EVENT, listener),
  onSession: (listener: (event: SessionEvent) => void) => subscribe(SESSION_EVENT, listener)
} as unknown as ServerApi

contextBridge.exposeInMainWorld('api', api)

// Un MessagePort no cruza contextBridge: se pasa a la página con window.postMessage (mismo origen).
ipcRenderer.on(TERMINAL_PORT_EVENT, (event, payload: { terminalId: string }) => {
  window.postMessage({ type: TERMINAL_PORT_MESSAGE, terminalId: payload.terminalId }, window.location.origin === 'null' ? '*' : window.location.origin, event.ports)
})
