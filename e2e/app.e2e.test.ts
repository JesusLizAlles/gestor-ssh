// Prueba de humo de la app completa: Playwright controla Electron contra un sshd desechable.
// Requiere `npm run build` (lo hace `npm run test:e2e`) y OpenSSH instalado (sshd y sftp-server).
// E2E_SCREENSHOTS=/ruta guarda capturas de cada paso.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ServerConfig } from '@shared/types'
import { tempDir } from '../tests/helpers'
import { sshdAvailable, startSshd, type TestSshd } from '../tests/sshd'

const shots = process.env.E2E_SCREENSHOTS

describe.skipIf(!sshdAvailable)('Gestor SSH (E2E)', () => {
  let sshd: TestSshd
  let app: ElectronApplication
  let page: Page
  let www: string
  let local: string

  const shot = async (name: string) => {
    if (!shots) return
    await mkdir(shots, { recursive: true })
    await page.screenshot({ path: join(shots, `${name}.png`) })
  }
  const row = (name: string) => page.locator('.tab-body:not(.hidden) .file-row', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}`) })

  beforeAll(async () => {
    sshd = await startSshd()
    www = join(sshd.dir, 'www')
    await mkdir(join(www, 'logs'), { recursive: true })
    await writeFile(join(www, 'index.html'), '<h1>Hola</h1>\n')
    await writeFile(join(www, 'config.ini'), '[app]\nentorno=pruebas\n')
    await writeFile(join(www, 'deploy.sh'), '#!/bin/sh\necho desplegando\n', { mode: 0o755 })
    await writeFile(join(www, 'logs', 'app.log'), 'arranque\n')

    const userData = await tempDir('gestor-ssh-e2e-')
    local = await tempDir('gestor-ssh-e2e-local-')
    const server: ServerConfig = {
      id: 'e2e',
      name: 'Servidor de pruebas',
      host: sshd.host,
      port: sshd.port,
      username: sshd.username,
      authMethod: 'privateKey',
      privateKeyPath: sshd.clientKeyPath,
      environment: 'test',
      initialPath: www,
      modules: ['services', 'apache', 'mysql', 'security']
    }
    await writeFile(join(userData, 'servers.json'), JSON.stringify({ version: 1, servers: [server] }))

    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--password-store=basic'], env: { ...process.env } as Record<string, string> })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 800 })
    // La ventana se crea oculta y se enseña en ready-to-show: hasta entonces no se puede capturar.
    const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    for (let start = Date.now(); !(await visible()); ) {
      if (Date.now() - start > 15_000) throw new Error('La ventana no llegó a mostrarse')
      await new Promise((r) => setTimeout(r, 100))
    }
    await page.locator('.server').waitFor()
  })

  afterAll(async () => {
    await app?.close()
    await sshd?.stop()
  })

  it('muestra el servidor guardado', async () => {
    await expect(page.locator('.server .name').textContent()).resolves.toBe('Servidor de pruebas')
    await shot('01-inicio')
  })

  it('pide confiar en la huella y abre el explorador', async () => {
    await page.locator('.server').dblclick()
    await page.getByText('Servidor desconocido').waitFor()
    await expect(page.locator('.fingerprint').textContent()).resolves.toMatch(/^SHA256:/)
    await shot('02-huella')
    await page.getByRole('button', { name: 'Confiar y conectar' }).click()
    await row('index.html').waitFor()
    const names = await page.locator('.tab-body:not(.hidden) .file-row .fname span').allTextContents()
    expect(names).toEqual(['logs', 'config.ini', 'deploy.sh', 'index.html'])
    await expect(row('deploy.sh').locator('.perm').textContent()).resolves.toBe('-rwxr-xr-x')
    await expect.poll(() => page.locator('.state-dot.connected').count()).toBe(1)
    await shot('03-explorador')
  })

  it('entra en carpetas y vuelve con las migas de pan', async () => {
    await row('logs').dblclick()
    await row('app.log').waitFor()
    await page.locator('.crumb', { hasText: /^www$/ }).click()
    await row('index.html').waitFor()
  })

  it('edita y guarda un fichero en el servidor', async () => {
    await row('config.ini').dblclick()
    const editor = page.locator('.tab-body:not(.hidden) .monaco-editor')
    await editor.waitFor()
    await page.locator('.tab-body:not(.hidden) .view-lines', { hasText: 'entorno=pruebas' }).waitFor()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('nuevo=1')
    await expect.poll(() => page.locator('.tab.active .dirty').count()).toBe(1)
    await page.keyboard.press('Control+S')
    await page.locator('.editor-status.ok', { hasText: 'Guardado' }).waitFor()
    expect(await readFile(join(www, 'config.ini'), 'utf8')).toBe('[app]\nentorno=pruebas\nnuevo=1')
    await expect.poll(() => page.locator('.tab.active .dirty').count()).toBe(0)
    await shot('04-editor')
  })

  it('abre un terminal en la carpeta del explorador', async () => {
    await page.locator('.tab', { hasText: 'www' }).click()
    await page.locator('.tab-body:not(.hidden) button[title="Abrir un terminal en esta carpeta"]').click()
    const rows = page.locator('.tab-body:not(.hidden) .xterm-rows')
    await rows.waitFor()
    // El shell ya ejecutó el `cd` inicial: está listo para leer lo que se escriba.
    await expect.poll(() => rows.textContent(), { timeout: 10_000 }).toContain(`cd -- '${www}'`)
    await page.waitForTimeout(1000)
    await page.locator('.tab-body:not(.hidden) .xterm').click()
    await page.keyboard.type("printf '%s-%s\\n' e2e ok; pwd")
    await page.keyboard.press('Enter')
    await expect.poll(() => rows.textContent(), { timeout: 10_000 }).toContain('e2e-ok')
    await expect.poll(() => rows.textContent(), { timeout: 10_000 }).toContain(www)
    await shot('05-terminal')
  })

  it('descarga un fichero y sube otro', async () => {
    await page.locator('.tab', { hasText: 'www' }).first().click()
    const target = join(local, 'index-descargado.html')
    // Los diálogos nativos se sustituyen en el proceso principal por respuestas fijas.
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
    }, target)
    await row('index.html').click()
    await page.locator('.tab-body:not(.hidden) button[title="Descargar lo seleccionado"]').click()
    await page.locator('.transfer .tstate.done').first().waitFor()
    expect(await readFile(target, 'utf8')).toBe('<h1>Hola</h1>\n')

    const toUpload = join(local, 'subido.txt')
    await writeFile(toUpload, 'desde la app\n')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
    }, toUpload)
    await page.locator('.tab-body:not(.hidden) button[title="Subir ficheros a esta carpeta"]').click()
    await row('subido.txt').waitFor()
    expect(await readFile(join(www, 'subido.txt'), 'utf8')).toBe('desde la app\n')
    await shot('06-transferencias')

    // Subirlo otra vez pregunta antes de sobrescribir.
    await page.locator('.tab-body:not(.hidden) button[title="Subir ficheros a esta carpeta"]').click()
    await page.getByText('Ya existen en el servidor').waitFor()
    await page.getByRole('button', { name: 'Cancelar' }).click()
  })

  it('crea, renombra y borra una carpeta', async () => {
    await page.locator('.tab-body:not(.hidden) button[title="Nueva carpeta"]').click()
    await page.locator('#prompt-value').fill('carpeta nueva')
    await page.keyboard.press('Enter')
    await row('carpeta nueva').waitFor()
    await page.locator('.tab-body:not(.hidden) .files').press('F2')
    await page.locator('#prompt-value').fill('renombrada')
    await page.keyboard.press('Enter')
    await row('renombrada').waitFor()
    await page.locator('.tab-body:not(.hidden) .files').press('Delete')
    await page.getByRole('button', { name: 'Eliminar' }).click()
    await expect.poll(() => row('renombrada').count()).toBe(0)
  })

  it('abre el módulo de servicios y enseña el estado de uno', async () => {
    await page.locator('.module-row', { hasText: 'Servicios' }).click()
    await page.locator('.unit-row').first().waitFor({ timeout: 15_000 })
    await page.getByPlaceholder('Buscar servicio…').fill('journald')
    await page.locator('.unit-row', { hasText: 'systemd-journald' }).first().click()
    await page.locator('.service-panel .state-pill.ok').waitFor()
    await expect.poll(() => page.locator('.service-panel .service-name').textContent()).toBe('systemd-journald.service')
    await page.locator('.log-text').waitFor()
    await shot('07-servicios')
  })

  it('abre Apache y MySQL (instalados o no)', async () => {
    await page.locator('.module-row', { hasText: 'Apache' }).click()
    await page.locator('.tab-body:not(.hidden) .module-header, .tab-body:not(.hidden) .welcome:has-text("no está instalado")').first().waitFor({ timeout: 15_000 })
    await shot('08-apache')
    await page.locator('.module-row', { hasText: 'MySQL' }).click()
    await page.locator('.tab-body:not(.hidden) .module-header, .tab-body:not(.hidden) .welcome:has-text("no está instalado")').first().waitFor({ timeout: 15_000 })
    await shot('09-mysql')
  })

  it('el diálogo del servidor detecta los módulos', async () => {
    await page.locator('.server').first().hover()
    await page.locator('.server button[title="Editar"]').first().click()
    await page.getByText('Detectar qué hay instalado').click()
    await page.locator('.dialog .notice.ok', { hasText: 'Detectado' }).waitFor({ timeout: 15_000 })
    await shot('10-detectar-modulos')
    await page.locator('.dialog').getByRole('button', { name: 'Cancelar' }).click()
  })

  it('pide la contraseña de sudo cuando hace falta y se puede cancelar', async () => {
    let needsPassword = true
    try {
      execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' })
      needsPassword = false
    } catch {
      // sudo pide contraseña (o no hay sudo): es el caso que se prueba.
    }
    await page.locator('.module-row', { hasText: 'MySQL' }).click()
    const installed = await page.locator('.tab-body:not(.hidden) .module-header').count()
    if (!needsPassword || !installed) return
    await page.locator('.tab-body:not(.hidden) .subtab', { hasText: 'Bases de datos' }).click()
    await page.locator('.dialog h2', { hasText: 'Contraseña de sudo' }).waitFor()
    // No se escribe ninguna contraseña: una incorrecta contaría como fallo de login en el equipo (pam_faillock).
    await shot('11-sudo')
    await page.locator('.dialog').getByRole('button', { name: 'Cancelar' }).click()
    await page.locator('.tab-body:not(.hidden) .notice.error', { hasText: 'Cancelado' }).waitFor()
  })

  it('seguridad: resumen, conexiones (con la propia) y puertos', async () => {
    await page.locator('.module-row', { hasText: 'Seguridad' }).click()
    const body = page.locator('.tab-body:not(.hidden)')
    await body.locator('.stat-card').first().waitFor()
    await expect.poll(() => body.locator('.stat-card .stat-value').first().textContent(), { timeout: 15_000 }).not.toBe('…')
    await shot('12-seguridad-resumen')
    await body.locator('.subtab', { hasText: 'Conexiones' }).click()
    await body.getByText('Ocultar localhost').click()
    await body.locator('td', { hasText: '127.0.0.1' }).first().waitFor({ timeout: 15_000 })
    await body.locator('.badge', { hasText: 'tú' }).first().waitFor()
    await shot('13-seguridad-conexiones')
    await body.locator('.subtab', { hasText: 'Puertos abiertos' }).click()
    await body.locator('td.num', { hasText: String(sshd.port) }).first().waitFor({ timeout: 15_000 })
    await shot('14-seguridad-puertos')
  })

  it('seguridad: ofrece la base de datos de países y, al descargarla, enseña el país', async () => {
    const body = page.locator('.tab-body:not(.hidden)')
    await body.locator('.subtab', { hasText: 'Resumen' }).click()
    await body.locator('.geo-notice').waitFor()
    // La descarga real (4 MB de db-ip.com) solo si se pide, para no depender de la red en CI.
    if (!process.env.GEOIP_NETWORK) return
    await body.locator('.geo-notice button', { hasText: 'Descargar' }).click()
    await body.locator('.geo-attribution').waitFor({ timeout: 60_000 })
    await expect.poll(() => body.locator('.geo-notice').count()).toBe(0)
    await shot('15-seguridad-paises')
  })
})
