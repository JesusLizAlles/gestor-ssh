import { SUDO_PASSWORD_REQUIRED } from '@shared/modules'
import type { ServerSession } from './sessions'

export interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
  /** La salida superó el límite y se cortó. */
  truncated: boolean
}

export interface RunOptions {
  /** Ejecutar como root con sudo (si el usuario ya es root, no hace falta). */
  sudo?: boolean
  timeoutMs?: number
  /** Máximo de bytes de salida estándar que se guardan. */
  maxBytes?: number
}

/** Antes de cada script: mensajes en inglés (para poder interpretarlos) y las carpetas sbin en el PATH. */
const PRELUDE = 'export LC_ALL=C LANG=C PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"\n'

/**
 * El script viaja en base64 dentro de unas comillas simples sin barras ni comillas: así lo interpreta
 * igual cualquier shell de login (bash, zsh, fish, csh…) y llega intacto a `sh`. La entrada estándar
 * queda libre para la contraseña de sudo; los scripts nunca la leen.
 */
export function wrapScript(script: string): string {
  const encoded = Buffer.from(PRELUDE + script, 'utf8').toString('base64')
  return `sh -c 'eval "$(printf %s ${encoded} | base64 -d)"'`
}

/** Ejecuta una línea de comandos tal cual en el servidor y recoge su salida. */
export function execRaw(session: ServerSession, command: string, input: string | null, opts: RunOptions = {}): Promise<RunResult> {
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024
  return new Promise((resolve, reject) => {
    session.client.exec(command, (err, stream) => {
      if (err) return reject(new Error(`No se pudo ejecutar el comando: ${err.message}`))
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      let stderr = ''
      const timer = setTimeout(() => {
        stream.close()
        reject(new Error('El comando tardó demasiado y se canceló'))
      }, opts.timeoutMs ?? 30_000)
      stream.on('data', (chunk: Buffer) => {
        if (size >= maxBytes) {
          truncated = true
          return
        }
        chunks.push(chunk.subarray(0, maxBytes - size))
        size += Math.min(chunk.length, maxBytes - size)
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 65_536) stderr += chunk.toString('utf8')
      })
      stream.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve({ code, stdout: Buffer.concat(chunks), stderr, truncated })
      })
      if (input !== null) stream.write(input)
      stream.end()
    })
  })
}

const NEEDS_PASSWORD = /a password is required|a terminal is required/i
const WRONG_PASSWORD = /incorrect password|no password was provided|Sorry, try again/i
const NOT_ALLOWED = /is not in the sudoers file|is not allowed to (run|execute)|may not run sudo/i

function sudoProblem(result: RunResult, username: string): Error | null {
  if (NOT_ALLOWED.test(result.stderr)) return new Error(`El usuario ${username} no tiene permiso para usar sudo en este servidor`)
  if (result.code === 127 && /sudo: (command )?not found|sudo: not found/.test(result.stderr)) {
    return new Error('sudo no está instalado en el servidor: conéctate como root para esta operación')
  }
  return null
}

/**
 * Ejecuta un script de sh. Con `sudo`, primero lo intenta sin contraseña (NOPASSWD); si sudo la pide,
 * usa la que esté en memoria para esta conexión o lanza SUDO_PASSWORD_REQUIRED para que se pida.
 */
export async function runScript(session: ServerSession, script: string, opts: RunOptions = {}): Promise<RunResult> {
  const command = wrapScript(script)
  const username = session.config.username
  if (!opts.sudo || username === 'root') return execRaw(session, command, null, opts)

  const withoutPassword = await execRaw(session, `env LC_ALL=C sudo -n ${command}`, null, opts)
  const problem = sudoProblem(withoutPassword, username)
  if (problem) throw problem
  if (!(withoutPassword.code !== 0 && NEEDS_PASSWORD.test(withoutPassword.stderr))) return withoutPassword

  const password = session.sudoPassword
  if (!password) throw new Error(SUDO_PASSWORD_REQUIRED)
  // Solo se llega aquí cuando sudo ha dicho que necesita la contraseña, así que la va a leer él.
  const result = await execRaw(session, `env LC_ALL=C sudo -S -p '' ${command}`, `${password}\n`, opts)
  if (WRONG_PASSWORD.test(result.stderr)) {
    session.sudoPassword = null
    throw new Error(SUDO_PASSWORD_REQUIRED)
  }
  const after = sudoProblem(result, username)
  if (after) throw after
  return result
}

/** Comprueba la contraseña de sudo y, si vale, la guarda en memoria para esta conexión. */
export async function setSudoPassword(session: ServerSession, password: string): Promise<void> {
  const result = await execRaw(session, `env LC_ALL=C sudo -S -p '' -v`, `${password}\n`)
  const problem = sudoProblem(result, session.config.username)
  if (problem) throw problem
  if (result.code !== 0) throw new Error(WRONG_PASSWORD.test(result.stderr) ? 'Contraseña de sudo incorrecta' : result.stderr.trim() || 'sudo rechazó la contraseña')
  session.sudoPassword = password
}

/** Texto de la salida (estándar y de errores) para enseñarlo tal cual. */
export const outputText = (result: RunResult): string =>
  [result.stdout.toString('utf8').trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n')
