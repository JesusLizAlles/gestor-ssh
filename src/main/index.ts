import { appendFile, mkdir, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, net, safeStorage, session as electronSession, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { HOST_KEY_EVENT, MCP_ACTIVITY_EVENT, MCP_STATUS_EVENT, SESSION_EVENT, TRANSFER_EVENT, UPDATE_STATE_EVENT } from '@shared/ipc'
import { GeoIp } from './geoip'
import { HostKeyPrompter } from './host-prompt'
import { registerIpc } from './ipc'
import { McpController } from './mcp/server'
import { runModuleCall } from './modules'
import { SessionManager } from './ssh/sessions'
import { KnownHosts } from './store/known-hosts'
import { SecretVault, type SecretCipher } from './store/secrets'
import { ServerStore } from './store/servers'
import { TransferManager } from './transfers'
import { Updater, type UpdaterBackend } from './updater'
import icon from '../../resources/icon.png?asset'

const here = import.meta.dirname

/** safeStorage usa el llavero del sistema (libsecret/KWallet, Keychain, DPAPI). */
const electronCipher: SecretCipher = {
  async status() {
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend()
      // basic_text cifra con una clave fija: no sirve para guardar contraseñas.
      return { persistent: available && backend !== 'basic_text' && backend !== 'unknown', backend }
    }
    return { persistent: available, backend: process.platform === 'darwin' ? 'keychain' : 'dpapi' }
  },
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: async (data) => {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data)
    return { value: result, reencrypt: shouldReEncrypt }
  }
}

let mainWindow: BrowserWindow | null = null

/** Registro del actualizador en logs/updater.log (se vacía al pasar de 1 MB). */
function updaterLog(line: string): void {
  const dir = app.getPath('logs')
  const file = join(dir, 'updater.log')
  void (async () => {
    await mkdir(dir, { recursive: true })
    const size = await stat(file).then((s) => s.size, () => 0)
    if (size > 1_000_000) await truncate(file, 0)
    await appendFile(file, `${new Date().toISOString()} ${line}\n`)
  })().catch(() => {})
}

const RELEASES_URL = 'https://github.com/JesusLizAlles/gestor-ssh/releases'

/**
 * En macOS la app no va firmada con Developer ID y Squirrel.Mac no instalaría la versión nueva:
 * se abre en el navegador el .dmg de la arquitectura de este equipo (nombre de electron-builder.yml).
 */
function openMacDownload(version: string): void {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  void shell.openExternal(`${RELEASES_URL}/download/v${version}/gestor-ssh-${version}-mac-${arch}.dmg`)
}

/** electron-updater solo sirve en la app instalada y, en Linux, si se ejecuta como AppImage. */
function updaterBackend(): { backend: UpdaterBackend | null; reason?: string; manualDownload?: (version: string) => void } {
  if (!app.isPackaged) return { backend: null, reason: 'Las actualizaciones automáticas solo funcionan en la app instalada.' }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return { backend: null, reason: 'Esta instalación no es un AppImage: descarga las versiones nuevas desde GitHub.' }
  }
  const { autoUpdater } = electronUpdater
  autoUpdater.logger = {
    info: (m: unknown) => updaterLog(`INFO ${String(m)}`),
    warn: (m: unknown) => updaterLog(`WARN ${String(m)}`),
    error: (m: unknown) => updaterLog(`ERROR ${String(m)}`),
    debug: (m: unknown) => updaterLog(`DEBUG ${String(m)}`)
  }
  return {
    backend: autoUpdater as unknown as UpdaterBackend,
    manualDownload: process.platform === 'darwin' ? openMacDownload : undefined
  }
}

/**
 * Sin menú en Windows y Linux: así ningún atajo del menú le quita teclas al terminal.
 * En macOS hace falta para Cmd+C/V/Q.
 */
function applicationMenu(): Menu | null {
  if (process.platform !== 'darwin') return null
  return Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Gestor SSH',
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })
  win.once('ready-to-show', () => win.show())

  // La interfaz nunca navega fuera de la app; los enlaces (p. ej. los del terminal) van al navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(here, '../renderer/index.html'))

  // Ayuda de desarrollo: GESTOR_SCREENSHOT=/ruta.png captura la ventana y cierra la app.
  const screenshotPath = process.env.GESTOR_SCREENSHOT
  if (screenshotPath && !app.isPackaged) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        await writeFile(screenshotPath, (await win.webContents.capturePage()).toPNG())
        app.quit()
      }, Number(process.env.GESTOR_SCREENSHOT_DELAY ?? 2500))
    })
  }
  return win
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(applicationMenu())
  // El terminal necesita leer y escribir el portapapeles; cualquier otro permiso se deniega.
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write'])
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

  const dataDir = app.getPath('userData')
  const vault = new SecretVault(dataDir, electronCipher)
  const store = new ServerStore(dataDir, vault)
  const knownHosts = new KnownHosts(dataDir)
  const send = (channel: string, payload: unknown): boolean => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    mainWindow.webContents.send(channel, payload)
    return true
  }
  const hostPrompt = new HostKeyPrompter((request) => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
    return send(HOST_KEY_EVENT, request)
  })
  const sessions = new SessionManager({
    knownHosts,
    confirmHost: (host, port, fingerprint) => hostPrompt.ask(host, port, fingerprint),
    onClosed: (serverId, reason) => send(SESSION_EVENT, { serverId, kind: 'closed', reason })
  })
  const transfers = new TransferManager({ emit: (info) => send(TRANSFER_EVENT, info) })

  // net.fetch usa el proxy del sistema (redes corporativas).
  const geoip = new GeoIp(dataDir, (url) => net.fetch(url))

  const { backend, reason, manualDownload } = updaterBackend()
  const updater = new Updater({
    backend,
    currentVersion: app.getVersion(),
    unsupportedReason: reason,
    manualDownload,
    send: (state) => send(UPDATE_STATE_EVENT, state),
    log: updaterLog
  })

  const mcp = new McpController({
    dataDir,
    version: app.getVersion(),
    tools: {
      listServers: () => store.list(),
      isConnected: (id) => sessions.isConnected(id),
      session: (id) => sessions.get(id),
      call: (session, call, args) => runModuleCall(session, call, args) as never,
      geoLookup: (ips) => geoip.lookup(ips)
    },
    onStatus: (status) => send(MCP_STATUS_EVENT, status),
    onActivity: (entry) => send(MCP_ACTIVITY_EVENT, entry)
  })
  void mcp.init().catch((err) => console.error('MCP:', err))

  registerIpc({ store, vault, knownHosts, sessions, transfers, hostPrompt, geoip, updater, mcp, window: () => mainWindow })

  const openWindow = () => {
    mainWindow = createWindow()
    // Al recargar la página, las preguntas pendientes ya no tienen quien las conteste.
    mainWindow.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) hostPrompt.rejectAll()
    })
    mainWindow.on('closed', () => {
      mainWindow = null
      hostPrompt.rejectAll()
      sessions.closeAll()
    })
  }
  openWindow()
  updater.startAutoCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
  app.on('before-quit', () => {
    sessions.closeAll()
    void mcp.stop()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
