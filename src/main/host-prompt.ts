import { randomUUID } from 'node:crypto'
import type { HostKeyRequest } from '@shared/types'

/** Preguntas pendientes al usuario sobre huellas nuevas. Sin ventana a la que preguntar, se rechaza. */
export class HostKeyPrompter {
  private readonly pending = new Map<string, (accept: boolean) => void>()

  constructor(private readonly send: (request: HostKeyRequest) => boolean) {}

  ask(host: string, port: number, fingerprint: string): Promise<boolean> {
    const requestId = randomUUID()
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve)
      if (!this.send({ requestId, host, port, fingerprint })) this.respond(requestId, false)
    })
  }

  respond(requestId: string, accept: boolean): void {
    const resolve = this.pending.get(requestId)
    this.pending.delete(requestId)
    resolve?.(accept)
  }

  /** La ventana se cerró o se recargó: nadie va a contestar. */
  rejectAll(): void {
    for (const id of [...this.pending.keys()]) this.respond(id, false)
  }
}
