import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Client } from 'ssh2'
import type { ConnectResult, ServerConfig, TestResult } from '@shared/types'
import type { KnownHosts } from '../store/known-hosts'
import type { Secrets } from '../store/secrets'
import { runScript } from './commands'
import { connectSsh, type HostDecision, type SshAuth } from './connect'
import { openSftp, Sftp } from './sftp'

export interface SessionDeps {
  knownHosts: KnownHosts
  /** Pregunta al usuario si se fía de una huella nueva. */
  confirmHost: (host: string, port: number, fingerprint: string) => Promise<boolean>
  /** Socket del agente SSH; inyectable para los tests. */
  agentSocket?: string
  /** La conexión se cayó sola (no al cerrarla nosotros). */
  onClosed?: (serverId: string, reason: string) => void
  timeoutMs?: number
}

/** Una conexión abierta a un servidor. Sobre ella van el explorador, los terminales y las transferencias. */
export class ServerSession {
  private browser: Promise<Sftp> | null = null
  private closedByUs = false
  /** Contraseña de sudo de esta conexión (solo en memoria). Al empezar, la de la conexión si la hay. */
  sudoPassword: string | null = null
  private readonly closeHandlers = new Set<() => void>()

  constructor(
    readonly config: ServerConfig,
    readonly client: Client,
    readonly fingerprint: string,
    readonly home: string,
    browser: Sftp
  ) {
    this.browser = Promise.resolve(browser)
    this.watchBrowser(browser)
  }

  /** Canal SFTP del explorador; si se cerró (p. ej. el servidor lo cortó), se abre otro. */
  sftp(): Promise<Sftp> {
    this.browser ??= openSftp(this.client).then((raw) => {
      const sftp = new Sftp(raw)
      this.watchBrowser(sftp)
      return sftp
    })
    const current = this.browser
    current.catch(() => {
      if (this.browser === current) this.browser = null
    })
    return current
  }

  /** Canal SFTP propio, para una transferencia: así se puede cancelar cerrándolo. */
  async dedicatedSftp(): Promise<Sftp> {
    return new Sftp(await openSftp(this.client))
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  get closed(): boolean {
    return this.closedByUs
  }

  close(): void {
    if (this.closedByUs) return
    this.closedByUs = true
    for (const handler of this.closeHandlers) handler()
    this.client.end()
  }

  private watchBrowser(sftp: Sftp): void {
    sftp.raw.on('close', () => {
      this.browser = null
    })
  }
}

/** Conexiones abiertas, una por servidor. */
export class SessionManager {
  private readonly sessions = new Map<string, ServerSession>()
  private readonly connecting = new Map<string, Promise<ServerSession>>()

  constructor(private readonly deps: SessionDeps) {}

  get(serverId: string): ServerSession {
    const session = this.sessions.get(serverId)
    if (!session) throw new Error('El servidor no está conectado')
    return session
  }

  isConnected(serverId: string): boolean {
    return this.sessions.has(serverId)
  }

  async connect(config: ServerConfig, secrets: Secrets): Promise<ConnectResult> {
    const existing = this.sessions.get(config.id)
    if (existing) return { fingerprint: existing.fingerprint, home: existing.home }
    let pending = this.connecting.get(config.id)
    if (!pending) {
      pending = this.open(config, secrets)
      this.connecting.set(config.id, pending)
    }
    try {
      const session = await pending
      return { fingerprint: session.fingerprint, home: session.home }
    } finally {
      this.connecting.delete(config.id)
    }
  }

  /** Conexión suelta (no queda registrada): para probar o detectar módulos desde el formulario. */
  openTemporary(config: ServerConfig, secrets: Secrets): Promise<ServerSession> {
    return this.open(config, secrets, false)
  }

  /** Prueba la configuración del formulario: conecta, mira el sistema y cierra. */
  async test(config: ServerConfig, secrets: Secrets): Promise<TestResult> {
    const session = await this.open(config, secrets, false)
    try {
      const system = await runScript(session, 'uname -srm', { timeoutMs: 10_000 }).then(
        (r) => (r.code === 0 ? r.stdout.toString('utf8').trim() || null : null),
        () => null
      )
      return { fingerprint: session.fingerprint, home: session.home, system }
    } finally {
      session.close()
    }
  }

  disconnect(serverId: string): void {
    const session = this.sessions.get(serverId)
    this.sessions.delete(serverId)
    session?.close()
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }

  private async open(config: ServerConfig, secrets: Secrets, register = true): Promise<ServerSession> {
    const { knownHosts, confirmHost } = this.deps
    const { client, fingerprint } = await connectSsh({
      host: config.host,
      port: config.port,
      username: config.username,
      auth: await this.auth(config, secrets),
      timeoutMs: this.deps.timeoutMs,
      verifyHost: async (fp): Promise<HostDecision> => {
        const known = await knownHosts.check(config.host, config.port, fp)
        if (known === 'trusted') return 'accept'
        if (known === 'changed') return 'changed'
        if (!(await confirmHost(config.host, config.port, fp))) return 'reject'
        await knownHosts.remember(config.host, config.port, fp)
        return 'accept'
      }
    })
    let session: ServerSession
    try {
      const sftp = new Sftp(await openSftp(client))
      const home = await sftp.realpath('.')
      session = new ServerSession(config, client, fingerprint, home, sftp)
      if (config.authMethod === 'password') session.sudoPassword = secrets.password ?? null
    } catch (err) {
      client.end()
      throw err
    }
    if (!register) return session
    this.sessions.set(config.id, session)
    client.on('close', () => {
      if (this.sessions.get(config.id) !== session) return
      this.sessions.delete(config.id)
      const unexpected = !session.closed
      session.close()
      if (unexpected) this.deps.onClosed?.(config.id, 'Se perdió la conexión con el servidor')
    })
    return session
  }

  private async auth(config: ServerConfig, secrets: Secrets): Promise<SshAuth> {
    switch (config.authMethod) {
      case 'password':
        if (!secrets.password) throw new Error('Falta la contraseña: edita el servidor para guardarla')
        return { method: 'password', password: secrets.password }
      case 'privateKey': {
        if (!config.privateKeyPath) throw new Error('Falta la ruta de la clave privada')
        const path = config.privateKeyPath.replace(/^~(?=$|[\\/])/, homedir())
        const privateKey = await readFile(path).catch(() => {
          throw new Error(`No se puede leer la clave privada ${config.privateKeyPath}`)
        })
        return { method: 'privateKey', privateKey, passphrase: secrets.passphrase }
      }
      case 'agent': {
        const agentSocket =
          this.deps.agentSocket ??
          process.env.SSH_AUTH_SOCK ??
          (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
        if (!agentSocket) throw new Error('No hay agente SSH disponible (SSH_AUTH_SOCK vacío)')
        return { method: 'agent', agentSocket }
      }
    }
  }
}
