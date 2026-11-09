import { TERMINAL_PORT_MESSAGE } from '@shared/ipc'

// El preload entrega cada MessagePort con window.postMessage; aquí se reparten por id de terminal.
const ports = new Map<string, MessagePort>()
const waiters = new Map<string, (port: MessagePort) => void>()

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== TERMINAL_PORT_MESSAGE) return
  const port = event.ports[0]
  const id = String(event.data.terminalId)
  if (!port) return
  const waiter = waiters.get(id)
  if (waiter) {
    waiters.delete(id)
    waiter(port)
  } else ports.set(id, port)
})

/** Espera el puerto de un terminal; puede llegar antes o después de que acabe openTerminal. */
export function takeTerminalPort(terminalId: string, timeoutMs = 10_000): Promise<MessagePort> {
  const ready = ports.get(terminalId)
  if (ready) {
    ports.delete(terminalId)
    return Promise.resolve(ready)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(terminalId)
      reject(new Error('El terminal no respondió'))
    }, timeoutMs)
    waiters.set(terminalId, (port) => {
      clearTimeout(timer)
      resolve(port)
    })
  })
}
