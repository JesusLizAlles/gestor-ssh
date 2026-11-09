import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * Servidor OpenSSH desechable para los tests: sin root, en 127.0.0.1 y un puerto libre, con claves
 * recién generadas. Entra con el usuario que ejecuta los tests.
 */
export interface TestSshd {
  host: string
  port: number
  username: string
  /** Clave privada del cliente (sin frase de paso). */
  clientKeyPath: string
  /** Clave con frase de paso «secreto». */
  protectedKeyPath: string
  /** Carpeta temporal para que los tests jueguen con ficheros. */
  dir: string
  stop(): Promise<void>
}

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p))
const SFTP_SERVER = ['/usr/lib/ssh/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/libexec/sftp-server', '/usr/libexec/openssh/sftp-server'].find((p) =>
  existsSync(p)
)

export const sshdAvailable = Boolean(SSHD && SFTP_SERVER && process.platform !== 'win32')

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitForPort(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.end()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`sshd no arrancó en el puerto ${port}`)
}

export async function startSshd(): Promise<TestSshd> {
  const root = await mkdtemp(join(tmpdir(), 'gestor-ssh-sshd-'))
  const keygen = (file: string, passphrase = '') => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-f', join(root, file)])
  keygen('host_key')
  keygen('client_key')
  keygen('protected_key', 'secreto')
  const keys = [await readFile(join(root, 'client_key.pub'), 'utf8'), await readFile(join(root, 'protected_key.pub'), 'utf8')]
  await writeFile(join(root, 'authorized_keys'), keys.join(''), { mode: 0o600 })
  const port = await freePort()
  await writeFile(
    join(root, 'sshd_config'),
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(root, 'host_key')}`,
      `PidFile ${join(root, 'sshd.pid')}`,
      `AuthorizedKeysFile ${join(root, 'authorized_keys')}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'UsePAM no',
      'StrictModes no',
      `Subsystem sftp ${SFTP_SERVER}`,
      'LogLevel ERROR'
    ].join('\n')
  )
  const child: ChildProcess = spawn(SSHD!, ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: 'ignore' })
  await waitForPort(port)
  const dir = join(root, 'files')
  execFileSync('mkdir', ['-p', dir])
  return {
    host: '127.0.0.1',
    port,
    username: userInfo().username,
    clientKeyPath: join(root, 'client_key'),
    protectedKeyPath: join(root, 'protected_key'),
    dir,
    stop: async () => {
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  }
}
