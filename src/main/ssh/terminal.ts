import type { ClientChannel } from 'ssh2'
import { z } from 'zod'
import type { TerminalToRenderer } from '@shared/types'
import type { ServerSession } from './sessions'

/** Lo mínimo que hace falta del MessagePort del terminal (así se puede probar sin Electron). */
export interface TerminalChannel {
  send(message: TerminalToRenderer): void
  onMessage(listener: (message: unknown) => void): void
  onClose(listener: () => void): void
  close(): void
}

const size = z.number().int().min(1).max(1000)
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(1_000_000) }),
  z.object({ type: z.literal('resize'), cols: size, rows: size }),
  z.object({ type: z.literal('ack'), bytes: z.number().int().min(0) }),
  z.object({ type: z.literal('close') })
])

/** Por encima de esto sin confirmar, se deja de leer del servidor hasta que el renderer pinte. */
const HIGH_WATER = 512 * 1024
const LOW_WATER = 128 * 1024
/** Se agrupa la salida en trozos de hasta 5 ms para no mandar miles de mensajes pequeños. */
const FLUSH_MS = 5

function openShell(session: ServerSession, cols: number, rows: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    session.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) reject(new Error(`No se pudo abrir el terminal: ${err.message}`))
      else resolve(stream)
    })
  })
}

/** Abre un shell interactivo en el servidor y lo conecta al canal del renderer. */
export async function startTerminal(session: ServerSession, channel: TerminalChannel, cols: number, rows: number): Promise<void> {
  const stream = await openShell(session, cols, rows)
  let pending: Buffer[] = []
  let timer: NodeJS.Timeout | null = null
  let unacked = 0
  let paused = false
  let finished = false

  const flush = () => {
    timer = null
    if (!pending.length) return
    const data = Buffer.concat(pending)
    pending = []
    unacked += data.length
    channel.send({ type: 'data', data: new Uint8Array(data) })
    if (!paused && unacked > HIGH_WATER) {
      paused = true
      stream.pause()
    }
  }
  const onData = (chunk: Buffer) => {
    pending.push(chunk)
    timer ??= setTimeout(flush, FLUSH_MS)
  }
  stream.on('data', onData)
  stream.stderr.on('data', onData)

  const finish = (reason: string) => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    flush()
    stopWatching()
    channel.send({ type: 'exit', reason })
    channel.close()
    stream.close()
  }
  stream.on('close', () => finish('Sesión terminada'))
  const stopWatching = session.onClose(() => finish('Conexión cerrada'))

  channel.onMessage((raw) => {
    const parsed = messageSchema.safeParse(raw)
    if (!parsed.success || finished) return
    const message = parsed.data
    switch (message.type) {
      case 'input':
        stream.write(message.data)
        break
      case 'resize':
        stream.setWindow(message.rows, message.cols, 0, 0)
        break
      case 'ack':
        unacked = Math.max(0, unacked - message.bytes)
        if (paused && unacked < LOW_WATER) {
          paused = false
          stream.resume()
        }
        break
      case 'close':
        finish('Terminal cerrado')
        break
    }
  })
  // La pestaña se cerró o la ventana se recargó.
  channel.onClose(() => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    stopWatching()
    stream.close()
  })
}
