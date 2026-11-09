import { Client, type ConnectConfig } from 'ssh2'
import { fingerprintOf } from '../store/known-hosts'

export type SshAuth =
  | { method: 'password'; password: string }
  | { method: 'privateKey'; privateKey: Buffer; passphrase?: string }
  | { method: 'agent'; agentSocket: string }

export type HostDecision = 'accept' | 'reject' | 'changed'

export interface ConnectOptions {
  host: string
  port: number
  username: string
  auth: SshAuth
  /**
   * Decide si se confía en la huella del servidor. Puede tardar lo que haga falta (el usuario
   * está decidiendo): mientras tanto no corre el tiempo de espera de la conexión.
   */
  verifyHost: (fingerprint: string) => Promise<HostDecision>
  timeoutMs?: number
}

export type SshErrorCode = 'HOST_KEY_CHANGED' | 'HOST_KEY_REJECTED' | 'AUTH' | 'NETWORK'

export class SshError extends Error {
  constructor(message: string, readonly code: SshErrorCode) {
    super(message)
    this.name = 'SshError'
  }
}

export interface SshConnection {
  client: Client
  fingerprint: string
}

function describeError(err: Error & { level?: string; code?: string }, host: string, port: number): SshError {
  if (err.level === 'client-authentication') {
    return new SshError('Autenticación rechazada: revisa el usuario, la contraseña o la clave', 'AUTH')
  }
  if (/passphrase|encrypted private key|bad decrypt/i.test(err.message)) {
    return new SshError('No se pudo descifrar la clave privada: revisa la frase de paso', 'AUTH')
  }
  if (/Cannot parse privateKey|Unsupported key format/i.test(err.message)) {
    return new SshError('La clave privada no tiene un formato válido', 'AUTH')
  }
  switch (err.code) {
    case 'ECONNREFUSED':
      return new SshError(`${host}:${port} rechazó la conexión`, 'NETWORK')
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new SshError(`No se encuentra el servidor ${host}`, 'NETWORK')
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new SshError(`No se llega a ${host}:${port}`, 'NETWORK')
    case 'ECONNRESET':
      return new SshError(`${host}:${port} cerró la conexión`, 'NETWORK')
  }
  return new SshError(`Error SSH: ${err.message}`, 'NETWORK')
}

/** Abre una conexión SSH autenticada. La huella del servidor la valida `verifyHost`. */
export function connectSsh(opts: ConnectOptions): Promise<SshConnection> {
  const client = new Client()
  const timeoutMs = opts.timeoutMs ?? 20_000
  let fingerprint = ''
  let hostProblem: SshError | null = null

  return new Promise<SshConnection>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const startTimer = () => {
      timer = setTimeout(() => fail(new SshError(`Tiempo de espera agotado conectando a ${opts.host}:${opts.port}`, 'NETWORK')), timeoutMs)
    }
    const stopTimer = () => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const fail = (err: SshError) => {
      if (settled) return
      settled = true
      stopTimer()
      client.removeAllListeners('ready')
      client.on('error', () => {})
      client.end()
      reject(err)
    }

    const config: ConnectConfig = {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      // El tiempo de espera lo llevamos nosotros para pararlo mientras el usuario mira la huella.
      readyTimeout: 0,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      tryKeyboard: opts.auth.method === 'password',
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        fingerprint = fingerprintOf(key)
        stopTimer()
        opts
          .verifyHost(fingerprint)
          .then((decision) => {
            if (settled) return
            if (decision === 'accept') {
              startTimer()
              verify(true)
              return
            }
            hostProblem =
              decision === 'changed'
                ? new SshError(
                    `La huella de ${opts.host}:${opts.port} ha cambiado (ahora es ${fingerprint}). ` +
                      'Puede ser una reinstalación del servidor o un ataque de intermediario. ' +
                      'Si sabes que es legítimo, olvida la huella guardada desde la edición del servidor.',
                    'HOST_KEY_CHANGED'
                  )
                : new SshError('Conexión cancelada: no se aceptó la huella del servidor', 'HOST_KEY_REJECTED')
            verify(false)
          })
          .catch(() => verify(false))
      }
    }
    if (opts.auth.method === 'password') config.password = opts.auth.password
    if (opts.auth.method === 'privateKey') {
      config.privateKey = opts.auth.privateKey
      if (opts.auth.passphrase) config.passphrase = opts.auth.passphrase
    }
    if (opts.auth.method === 'agent') config.agent = opts.auth.agentSocket

    // Servidores con «keyboard-interactive» en lugar de contraseña: se responde con la contraseña.
    const password = opts.auth.method === 'password' ? opts.auth.password : ''
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => password))
    })

    client.once('ready', () => {
      if (settled) return
      settled = true
      stopTimer()
      client.removeAllListeners('error')
      // A partir de aquí los errores llegan como 'close'; sin oyente, un 'error' tumbaría el proceso.
      client.on('error', () => {})
      resolve({ client, fingerprint })
    })
    client.once('error', (err) => fail(hostProblem ?? describeError(err, opts.host, opts.port)))
    client.once('close', () => fail(hostProblem ?? new SshError(`${opts.host}:${opts.port} cerró la conexión`, 'NETWORK')))

    startTimer()
    try {
      client.connect(config)
    } catch (err) {
      fail(describeError(err as Error, opts.host, opts.port))
    }
  })
}
