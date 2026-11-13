import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerConfig, TerminalToRenderer, TransferInfo } from '@shared/types'
import { SessionManager } from '../src/main/ssh/sessions'
import { startTerminal, type TerminalChannel } from '../src/main/ssh/terminal'
import { runScript } from '../src/main/ssh/commands'
import { detectModules, runModuleCall } from '../src/main/modules'
import { SUDO_PASSWORD_REQUIRED } from '@shared/modules'
import { execFileSync } from 'node:child_process'
import { KnownHosts } from '../src/main/store/known-hosts'
import { TransferManager } from '../src/main/transfers'
import { tempDir } from './helpers'
import { sshdAvailable, startSshd, type TestSshd } from './sshd'

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

describe.skipIf(!sshdAvailable)('contra un sshd real', () => {
  let sshd: TestSshd
  let config: ServerConfig
  let knownHosts: KnownHosts
  const asked: string[] = []
  let sessions: SessionManager

  beforeAll(async () => {
    sshd = await startSshd()
    config = {
      id: 'srv',
      name: 'Pruebas',
      host: sshd.host,
      port: sshd.port,
      username: sshd.username,
      authMethod: 'privateKey',
      privateKeyPath: sshd.clientKeyPath,
      environment: 'dev',
      initialPath: '',
      modules: []
    }
    knownHosts = new KnownHosts(await tempDir())
    sessions = new SessionManager({
      knownHosts,
      confirmHost: async (_host, _port, fp) => {
        asked.push(fp)
        return true
      }
    })
  })

  afterAll(async () => {
    sessions?.closeAll()
    await sshd?.stop()
  })

  describe('conexión y huellas', () => {
    it('pregunta la huella la primera vez y luego la recuerda', async () => {
      const first = await sessions.connect(config, {})
      expect(first.fingerprint).toMatch(/^SHA256:/)
      expect(first.home.startsWith('/')).toBe(true)
      expect(asked).toEqual([first.fingerprint])
      sessions.disconnect(config.id)
      await sessions.connect(config, {})
      expect(asked).toHaveLength(1)
    })

    it('no conecta si el usuario rechaza la huella', async () => {
      const manager = new SessionManager({ knownHosts: new KnownHosts(await tempDir()), confirmHost: async () => false })
      await expect(manager.connect({ ...config, id: 'otro' }, {})).rejects.toMatchObject({ code: 'HOST_KEY_REJECTED' })
    })

    it('bloquea la conexión si la huella cambió', async () => {
      const hosts = new KnownHosts(await tempDir())
      await hosts.remember(config.host, config.port, 'SHA256:otra-huella')
      const manager = new SessionManager({ knownHosts: hosts, confirmHost: async () => true })
      await expect(manager.connect({ ...config, id: 'otro' }, {})).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
    })

    it('clave con frase de paso: correcta y equivocada', async () => {
      const keyed = { ...config, id: 'protegida', privateKeyPath: sshd.protectedKeyPath }
      const manager = new SessionManager({ knownHosts, confirmHost: async () => true })
      await expect(manager.connect(keyed, { passphrase: 'mal' })).rejects.toThrow(/frase de paso/)
      await expect(manager.connect(keyed, { passphrase: 'secreto' })).resolves.toMatchObject({ fingerprint: expect.any(String) })
      manager.closeAll()
    })

    it('errores claros: clave inexistente, puerto cerrado, usuario rechazado', async () => {
      const manager = new SessionManager({ knownHosts, confirmHost: async () => true, timeoutMs: 5000 })
      await expect(manager.connect({ ...config, id: 'a', privateKeyPath: '/no/existe' }, {})).rejects.toThrow(/No se puede leer la clave/)
      await expect(manager.connect({ ...config, id: 'b', port: 1 }, {})).rejects.toThrow(/rechazó la conexión/)
      await expect(manager.connect({ ...config, id: 'c', username: 'usuario-que-no-existe' }, {})).rejects.toThrow(/Autenticación rechazada/)
    })

    it('test() devuelve el sistema y cierra la conexión', async () => {
      const result = await sessions.test({ ...config, id: 'prueba' }, {})
      expect(result.system).toMatch(/Linux|Darwin/)
      expect(sessions.isConnected('prueba')).toBe(false)
    })
  })

  describe('SFTP', () => {
    it('lista, crea, renombra, escribe, lee y borra', async () => {
      await sessions.connect(config, {})
      const sftp = await sessions.get(config.id).sftp()
      const base = join(sshd.dir, 'sftp')
      await mkdir(join(base, 'sub'), { recursive: true })
      await writeFile(join(base, 'b10.txt'), 'diez')
      await writeFile(join(base, 'b2.txt'), 'dos')
      await symlink(join(base, 'sub'), join(base, 'enlace'))
      await symlink(join(base, 'no-existe'), join(base, 'roto'))

      const listing = await sftp.listDir(base + '/./')
      expect(listing.path).toBe(base)
      expect(listing.entries.map((e) => e.name)).toEqual(['enlace', 'sub', 'b2.txt', 'b10.txt', 'roto'])
      const link = listing.entries.find((e) => e.name === 'enlace')!
      expect(link).toMatchObject({ type: 'link', linkTarget: 'dir' })
      expect(listing.entries.find((e) => e.name === 'roto')).toMatchObject({ type: 'link', linkTarget: undefined })
      expect(listing.entries.find((e) => e.name === 'b2.txt')).toMatchObject({ type: 'file', size: 3, owner: sshd.username })

      await sftp.mkdir(join(base, 'nueva'))
      await sftp.createExclusive(join(base, 'nueva', 'vacío.txt'))
      await expect(sftp.createExclusive(join(base, 'nueva', 'vacío.txt'))).rejects.toThrow()
      await sftp.writeFile(join(base, 'nueva', 'vacío.txt'), Buffer.from('ñandú\n'))
      expect((await sftp.readFile(join(base, 'nueva', 'vacío.txt'))).toString()).toBe('ñandú\n')
      await sftp.rename(join(base, 'nueva'), join(base, 'renombrada'))
      expect(await sftp.exists(join(base, 'renombrada', 'vacío.txt'))).toBe(true)
      await expect(sftp.listDir(join(base, 'nada'))).rejects.toThrow(/No existe/)

      // El borrado recursivo no sigue enlaces: lo enlazado sigue vivo.
      await sftp.removeRecursive(join(base, 'enlace'))
      expect(await sftp.exists(join(base, 'sub'))).toBe(true)
      await sftp.removeRecursive(join(base, 'renombrada'))
      expect(await sftp.exists(join(base, 'renombrada'))).toBe(false)
    })
  })

  describe('transferencias', () => {
    const run = async (manager: TransferManager, start: () => TransferInfo, updates: TransferInfo[]) => {
      const info = start()
      await manager.idle()
      return updates.filter((u) => u.id === info.id).at(-1)!
    }

    it('descarga y sube carpetas completas con su contenido', async () => {
      await sessions.connect(config, {})
      const session = sessions.get(config.id)
      const updates: TransferInfo[] = []
      const manager = new TransferManager({ emit: (u) => updates.push(u) })
      const remote = join(sshd.dir, 'origen')
      const big = randomBytes(3 * 1024 * 1024 + 17)
      await mkdir(join(remote, 'a', 'b'), { recursive: true })
      await writeFile(join(remote, 'grande.bin'), big)
      await writeFile(join(remote, 'a', 'b', 'hoja.txt'), 'hoja')
      await writeFile(join(remote, 'script.sh'), '#!/bin/sh\n', { mode: 0o755 })
      await symlink(join(remote, 'script.sh'), join(remote, 'enlace.sh'))
      await symlink(remote, join(remote, 'bucle'))

      const local = await tempDir()
      const down = await run(manager, () => manager.download(session, remote, join(local, 'origen')), updates)
      expect(down).toMatchObject({ state: 'done', totalFiles: 4, doneFiles: 4, error: null })
      expect(down.totalBytes).toBe(down.doneBytes)
      expect(sha(await readFile(join(local, 'origen', 'grande.bin')))).toBe(sha(big))
      expect(await readFile(join(local, 'origen', 'a', 'b', 'hoja.txt'), 'utf8')).toBe('hoja')
      expect(await readFile(join(local, 'origen', 'enlace.sh'), 'utf8')).toBe('#!/bin/sh\n')
      expect((await readdir(join(local, 'origen'))).sort()).toEqual(['a', 'enlace.sh', 'grande.bin', 'script.sh'])

      const target = join(sshd.dir, 'destino')
      await mkdir(target)
      const up = await run(manager, () => manager.upload(session, join(local, 'origen'), target), updates)
      expect(up).toMatchObject({ state: 'done', totalFiles: 4, destination: target })
      expect(sha(await readFile(join(target, 'origen', 'grande.bin')))).toBe(sha(big))
      expect((await stat(join(target, 'origen', 'script.sh'))).mode & 0o777).toBe(0o755)

      // Fichero suelto, a una ruta local con otro nombre.
      const single = await run(manager, () => manager.download(session, join(remote, 'a', 'b', 'hoja.txt'), join(local, 'copia.txt')), updates)
      expect(single.state).toBe('done')
      expect(await readFile(join(local, 'copia.txt'), 'utf8')).toBe('hoja')
    })

    it('cancelar a medias borra el fichero incompleto', async () => {
      const session = sessions.get(config.id)
      const updates: TransferInfo[] = []
      const manager = new TransferManager({ emit: (u) => updates.push(u) })
      const remote = join(sshd.dir, 'enorme.bin')
      await writeFile(remote, randomBytes(64 * 1024 * 1024))
      const local = join(await tempDir(), 'enorme.bin')
      const info = manager.download(session, remote, local)
      while (!updates.some((u) => u.id === info.id && u.doneBytes > 0)) await new Promise((r) => setTimeout(r, 5))
      manager.cancel(info.id)
      await manager.idle()
      expect(updates.at(-1)).toMatchObject({ id: info.id, state: 'cancelled' })
      await expect(stat(local)).rejects.toThrow()
    })

    it('un error se informa con la ruta', async () => {
      const session = sessions.get(config.id)
      const updates: TransferInfo[] = []
      const manager = new TransferManager({ emit: (u) => updates.push(u) })
      const result = await run(manager, () => manager.download(session, join(sshd.dir, 'no-existe'), join(sshd.dir, 'x')), updates)
      expect(result.state).toBe('error')
      expect(result.error).toMatch(/No existe/)
    })
  })

  describe('terminal', () => {
    it('ejecuta lo que se escribe, cambia de tamaño y se cierra', async () => {
      await sessions.connect(config, {})
      const session = sessions.get(config.id)
      let output = ''
      const messages: TerminalToRenderer[] = []
      let listener: (m: unknown) => void = () => {}
      let closed = false
      const channel: TerminalChannel = {
        send: (m) => {
          messages.push(m)
          if (m.type !== 'data') return
          const text = Buffer.from(m.data).toString()
          output += text
          // Algunos shells (fish) esperan la respuesta del terminal a «Primary DA» antes de arrancar.
          if (/\x1b\[0?c/.test(text)) setImmediate(() => listener({ type: 'input', data: '\x1b[?62;22c' }))
        },
        onMessage: (l) => (listener = l),
        onClose: () => {},
        close: () => (closed = true)
      }
      await startTerminal(session, channel, 80, 24)
      const waitFor = async (re: RegExp) => {
        const start = Date.now()
        while (!re.test(output)) {
          if (Date.now() - start > 5000) throw new Error(`No apareció ${re} en: ${output}`)
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      listener({ type: 'input', data: "printf '%s-%s\\n' resultado 42\r" })
      await waitFor(/resultado-42/)
      listener({ type: 'resize', cols: 132, rows: 40 })
      listener({ type: 'input', data: 'stty size\r' })
      await waitFor(/40 132/)
      listener({ type: 'basura' })
      listener({ type: 'input', data: 'exit\r' })
      const start = Date.now()
      while (!closed && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 20))
      expect(closed).toBe(true)
      expect(messages.at(-1)).toEqual({ type: 'exit', reason: 'Sesión terminada' })
    })
  })

  describe('comandos y módulos', () => {
    // ¿Puede el usuario de los tests usar sudo sin contraseña? (en CI sí; en un equipo normal, no)
    const sudoWithoutPassword = (() => {
      try {
        execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })()

    it('ejecuta scripts con comillas, barras y variables sea cual sea el shell de login', async () => {
      await sessions.connect(config, {})
      const session = sessions.get(config.id)
      const result = await runScript(session, `printf '%s|' "it's" 'a\\b' "$((40+2))"; echo; echo error >&2; exit 3`)
      expect(result.stdout.toString()).toBe("it's|a\\b|42|\n")
      expect(result.stderr).toBe('error\n')
      expect(result.code).toBe(3)
    })

    // Nunca se prueba una contraseña incorrecta contra el sudo real: cuenta como intento fallido y
    // pam_faillock puede bloquear la cuenta de quien ejecuta los tests.
    it.skipIf(sudoWithoutPassword)('sin NOPASSWD, sudo pide la contraseña (sin llegar a enviar ninguna)', async () => {
      const session = sessions.get(config.id)
      expect(session.sudoPassword).toBeNull()
      await expect(runScript(session, 'id -u', { sudo: true })).rejects.toThrow(SUDO_PASSWORD_REQUIRED)
    })

    it.skipIf(!sudoWithoutPassword)('con sudo sin contraseña, ejecuta como root y edita ficheros de root', async () => {
      const session = sessions.get(config.id)
      expect((await runScript(session, 'id -u', { sudo: true })).stdout.toString().trim()).toBe('0')
      const { sudoReadText, sudoWriteText } = await import('../src/main/sudo-files')
      const file = join(sshd.dir, 'de-root.conf')
      execFileSync('sudo', ['sh', '-c', `printf 'a=1\\n' > '${file}' && chmod 640 '${file}' && chown root:root '${file}'`])
      const read = await sudoReadText(session, file)
      expect(read.content).toBe('a=1\n')
      await sudoWriteText(session, file, 'a=2\n', read.mtime)
      expect(execFileSync('sudo', ['cat', file]).toString()).toBe('a=2\n')
      expect(execFileSync('sudo', ['stat', '-c', '%U %a', file]).toString().trim()).toBe('root 640')
    })

    it('detecta systemd y lista servicios', async () => {
      const session = sessions.get(config.id)
      const hasSystemd = (() => {
        try {
          execFileSync('systemctl', ['--version'], { stdio: 'ignore' })
          return true
        } catch {
          return false
        }
      })()
      expect((await detectModules(session)).includes('services')).toBe(hasSystemd)
      if (!hasSystemd) return
      const units = (await runModuleCall(session, 'services.list', {})) as { name: string; active: string }[]
      expect(units.length).toBeGreaterThan(5)
      const journald = units.find((u) => u.name === 'systemd-journald.service')
      expect(journald?.active).toBe('active')
      const detail = await runModuleCall(session, 'services.show', { unit: 'systemd-journald.service' })
      expect(detail).toMatchObject({ name: 'systemd-journald.service', active: 'active' })
      const logs = (await runModuleCall(session, 'services.logs', { unit: 'systemd-journald.service', lines: 10, sudo: false })) as { text: string }
      expect(typeof logs.text).toBe('string')
    })

    it('valida los argumentos de las llamadas', async () => {
      const session = sessions.get(config.id)
      await expect(runModuleCall(session, 'services.action', { unit: 'x; reboot.service', action: 'stop' })).rejects.toThrow(/no válido/)
      await expect(runModuleCall(session, 'services.action', { unit: 'ssh.service', action: 'mask' })).rejects.toThrow()
      await expect(runModuleCall(session, 'files.tail', { path: 'relativa', lines: 10 })).rejects.toThrow(/no válida/)
    })

    it('rendimiento: lee /proc, calcula tasas y consulta sysstat', async () => {
      const session = sessions.get(config.id)
      expect(await detectModules(session)).toContain('performance')
      const { pointFromSamples } = await import('@shared/performance')
      const first = (await runModuleCall(session, 'performance.sample', { disks: true })) as import('@shared/performance').PerfSample
      expect(first.cpus).toBeGreaterThan(0)
      expect(first.cpu).toHaveLength(8)
      expect(first.memTotal).toBeGreaterThan(0)
      expect(first.load).toHaveLength(3)
      expect(first.disks?.some((d) => d.mount === '/')).toBe(true)
      await new Promise((r) => setTimeout(r, 1100))
      const second = (await runModuleCall(session, 'performance.sample', { disks: false })) as import('@shared/performance').PerfSample
      expect(second.disks).toBeNull()
      const point = pointFromSamples(first, second)
      expect(point.cpu).toBeGreaterThanOrEqual(0)
      expect(point.cpu).toBeLessThanOrEqual(100)
      expect(point.netRx).toBeGreaterThanOrEqual(0)
      expect(point.mem).toBeGreaterThan(0)

      const history = (await runModuleCall(session, 'performance.history', { hours: 24 })) as import('@shared/performance').PerfHistory
      const hasSadf = (() => {
        try {
          execFileSync('sh', ['-c', 'command -v sadf'], { stdio: 'ignore' })
          return true
        } catch {
          return false
        }
      })()
      expect(history.status === 'missing').toBe(!hasSadf)
      await expect(runModuleCall(session, 'performance.history', { hours: 5 })).rejects.toThrow()
    })

    it('seguridad: ve la conexión de la propia app, sesiones y registro (sin sudo)', async () => {
      const session = sessions.get(config.id)
      const result = (await runModuleCall(session, 'security.connections', { sudo: false })) as {
        sockets: { state: string; localPort: string; peerAddress: string }[]
        clientIp: string | null
      }
      expect(result.clientIp).toBe('127.0.0.1')
      expect(result.sockets.some((s) => s.state === 'ESTAB' && s.localPort === String(sshd.port) && s.peerAddress === '127.0.0.1')).toBe(true)
      expect(result.sockets.some((s) => s.state === 'LISTEN' && s.localPort === String(sshd.port))).toBe(true)
      const sessionsResult = (await runModuleCall(session, 'security.sessions', {})) as { who: unknown[]; last: string }
      expect(Array.isArray(sessionsResult.who)).toBe(true)
      const ssh = (await runModuleCall(session, 'security.ssh', { sudo: false, hours: 24 })) as { events: unknown[]; source: string }
      expect(Array.isArray(ssh.events)).toBe(true)
    })

    it('seguridad: nunca bloquea la IP desde la que está conectada la app', async () => {
      const session = sessions.get(config.id)
      // Se rechaza antes de llegar a sudo o a fail2ban.
      await expect(runModuleCall(session, 'security.ban', { jail: 'sshd', ip: '127.0.0.1', ban: true })).rejects.toThrow(/te dejaría sin acceso/)
      await expect(runModuleCall(session, 'security.ban', { jail: 'sshd', ip: 'no-es-ip', ban: true })).rejects.toThrow(/IP no válida/)
      await expect(runModuleCall(session, 'security.ban', { jail: 'a;b', ip: '203.0.113.9', ban: true })).rejects.toThrow(/jail no válida/)
    })

    it.skipIf(!sudoWithoutPassword)('seguridad con sudo: fail2ban y cortafuegos responden', async () => {
      const session = sessions.get(config.id)
      const f2b = (await runModuleCall(session, 'security.fail2ban', {})) as { installed: boolean }
      expect(typeof f2b.installed).toBe('boolean')
      const fw = (await runModuleCall(session, 'security.firewall', {})) as { text: string }
      expect(typeof fw.text).toBe('string')
      const conns = (await runModuleCall(session, 'security.connections', { sudo: true })) as { sockets: { process: string | null }[] }
      expect(conns.sockets.some((s) => s.process === 'sshd' || s.process === 'sshd-session')).toBe(true)
    })

    it('los resúmenes de Apache y MySQL funcionan esté o no instalado', async () => {
      const session = sessions.get(config.id)
      const apache = (await runModuleCall(session, 'apache.overview', {})) as { installed: boolean; ctl: string | null }
      expect(apache.installed).toBe(apache.ctl !== null)
      const mysql = (await runModuleCall(session, 'mysql.overview', {})) as { installed: boolean }
      expect(typeof mysql.installed).toBe('boolean')
      const tail = (await runModuleCall(session, 'files.tail', { path: join(sshd.dir, 'sftp', 'b2.txt'), lines: 10 })) as { text: string }
      expect(tail.text).toBe('dos')
    })
  })
})
