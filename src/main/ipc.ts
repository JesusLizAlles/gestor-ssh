import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { basename as localBasename, extname, join as localJoin } from 'node:path'
import { app, dialog, ipcMain, MessageChannelMain, shell, type BrowserWindow, type WebContents } from 'electron'
import { channelName, TERMINAL_PORT_EVENT, type ApiChannel, type IpcEnvelope } from '@shared/ipc'
import { formatSize, looksLikeText } from '@shared/format'
import { basename, isValidName, join, parent, resolveFromHome } from '@shared/remote-path'
import {
  FILE_CHANGED_ERROR,
  MAX_EDIT_BYTES,
  type SaveServerInput,
  type ServerApi,
  type ServerConfig,
  type TerminalToRenderer,
  type UploadPlan
} from '@shared/types'
import { z, ZodError } from 'zod'
import type { GeoIp } from './geoip'
import type { HostKeyPrompter } from './host-prompt'
import { detectModules, isModuleCall, runModuleCall } from './modules'
import { setSudoPassword } from './ssh/commands'
import { sudoReadText, sudoWriteText } from './sudo-files'
import type { ServerSession, SessionManager } from './ssh/sessions'
import { entryType } from './ssh/sftp'
import { startTerminal } from './ssh/terminal'
import type { KnownHosts } from './store/known-hosts'
import type { Secrets, SecretVault } from './store/secrets'
import type { ServerStore } from './store/servers'
import type { TransferManager } from './transfers'
import type { Updater } from './updater'
import {
  idSchema,
  remotePathSchema,
  remotePathsSchema,
  saveFileSchema,
  saveServerSchema,
  terminalSizeSchema,
  uploadKindSchema,
  uploadModeSchema,
  uuidSchema
} from './validation'

export interface IpcDeps {
  store: ServerStore
  vault: SecretVault
  knownHosts: KnownHosts
  sessions: SessionManager
  transfers: TransferManager
  hostPrompt: HostKeyPrompter
  geoip: GeoIp
  updater: Updater
  window: () => BrowserWindow | null
}

type Handlers = { [K in ApiChannel]: (sender: WebContents, ...args: unknown[]) => ReturnType<ServerApi[K]> }

function errorMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return `Datos no válidos: ${err.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`
  }
  return err instanceof Error ? err.message : String(err)
}

/** Secretos para probar un servidor: los guardados (si existe) con los cambios del formulario encima. */
async function mergeSecrets(vault: SecretVault, input: SaveServerInput): Promise<Secrets> {
  const stored = input.config.id ? await vault.get(input.config.id) : {}
  for (const [key, value] of Object.entries(input.secrets ?? {}) as [keyof Secrets, string | null | undefined][]) {
    if (value === null) delete stored[key]
    else if (typeof value === 'string') stored[key] = value
  }
  return stored
}

/** `nombre.ext`, `nombre (1).ext`, `nombre (2).ext`… el primero que no exista en `dir`. */
async function uniqueLocalPath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  for (let i = 0; ; i++) {
    const candidate = localJoin(dir, i === 0 ? name : `${stem} (${i})${ext}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
}

export function registerIpc(deps: IpcDeps): void {
  const { store, vault, knownHosts, sessions, transfers, hostPrompt, geoip, updater, window } = deps
  // Ficheros elegidos para subir: startUpload los usa por token, sin recibir rutas locales del renderer.
  const pendingUploads = new Map<string, { serverId: string; remoteDir: string; localPaths: string[]; conflicts: Set<string> }>()

  const session = (id: unknown): ServerSession => sessions.get(idSchema.parse(id))
  /** Valida la ruta y la resuelve respecto a la carpeta personal (admite `~`). */
  const remote = (s: ServerSession, path: unknown): string => resolveFromHome(remotePathSchema.parse(path), s.home)
  const dialogParent = () => window() ?? undefined

  const handlers: Handlers = {
    secretStorageStatus: async () => vault.status(),
    listServers: () => store.list(),
    saveServer: async (_sender, raw) => {
      const input = saveServerSchema.parse(raw)
      const saved = await store.save(input)
      return saved
    },
    deleteServer: async (_sender, id) => {
      const serverId = idSchema.parse(id)
      transfers.cancelServer(serverId)
      sessions.disconnect(serverId)
      await store.delete(serverId)
    },
    pickPrivateKey: async () => {
      const options: Electron.OpenDialogOptions = {
        title: 'Clave privada',
        defaultPath: localJoin(app.getPath('home'), '.ssh'),
        properties: ['openFile', 'showHiddenFiles']
      }
      const parentWindow = dialogParent()
      const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    testServer: async (_sender, raw) => {
      const input = saveServerSchema.parse(raw)
      const config: ServerConfig = { ...input.config, id: input.config.id ?? 'prueba' }
      return sessions.test(config, await mergeSecrets(vault, input))
    },
    connect: async (_sender, id) => {
      const serverId = idSchema.parse(id)
      return sessions.connect(await store.get(serverId), await vault.get(serverId))
    },
    disconnect: async (_sender, id) => {
      const serverId = idSchema.parse(id)
      transfers.cancelServer(serverId)
      sessions.disconnect(serverId)
    },
    respondHostKey: async (_sender, requestId, accept) => {
      hostPrompt.respond(uuidSchema.parse(requestId), accept === true)
    },
    forgetHostKey: async (_sender, id) => {
      const config = await store.get(idSchema.parse(id))
      await knownHosts.forget(config.host, config.port)
    },

    listDir: async (_sender, id, path) => {
      const s = session(id)
      return (await s.sftp()).listDir(remote(s, path))
    },
    makeDir: async (_sender, id, path) => {
      const s = session(id)
      const target = remote(s, path)
      if (!isValidName(basename(target))) throw new Error('Nombre de carpeta no válido')
      await (await s.sftp()).mkdir(target)
    },
    createFile: async (_sender, id, path) => {
      const s = session(id)
      const target = remote(s, path)
      if (!isValidName(basename(target))) throw new Error('Nombre de fichero no válido')
      await (await s.sftp()).createExclusive(target)
    },
    rename: async (_sender, id, from, to) => {
      const s = session(id)
      const source = remote(s, from)
      const target = remote(s, to)
      const sftp = await s.sftp()
      // SFTP v3 no define qué pasa si el destino existe: mejor no arriesgarse a pisarlo.
      if (await sftp.exists(target)) throw new Error(`Ya existe ${basename(target)} en ${parent(target)}`)
      await sftp.rename(source, target)
    },
    remove: async (_sender, id, paths) => {
      const s = session(id)
      const sftp = await s.sftp()
      for (const path of remotePathsSchema.parse(paths)) {
        const target = remote(s, path)
        if (target === '/') throw new Error('No se puede borrar la raíz')
        await sftp.removeRecursive(target)
      }
    },
    readTextFile: async (_sender, id, path, sudo) => {
      const s = session(id)
      const target = remote(s, path)
      if (sudo === true) return sudoReadText(s, target)
      const sftp = await s.sftp()
      const info = await sftp.stat(target)
      if (entryType(info.mode) !== 'file') throw new Error('Solo se pueden abrir ficheros')
      if (info.size > MAX_EDIT_BYTES) {
        throw new Error(`El fichero ocupa ${formatSize(info.size)}; el editor admite hasta ${formatSize(MAX_EDIT_BYTES)}. Descárgalo.`)
      }
      const data = await sftp.readFile(target)
      if (!looksLikeText(data)) throw new Error('Parece un fichero binario (o no está en UTF-8): descárgalo para abrirlo')
      return { path: target, content: data.toString('utf8'), size: data.length, mtime: info.mtime * 1000 }
    },
    saveTextFile: async (_sender, raw) => {
      const input = saveFileSchema.parse(raw)
      const s = session(input.serverId)
      const target = remote(s, input.path)
      if (input.sudo) return sudoWriteText(s, target, input.content, input.expectedMtime)
      const sftp = await s.sftp()
      if (input.expectedMtime !== null) {
        const current = await sftp.stat(target).catch(() => null)
        if (current && current.mtime * 1000 !== input.expectedMtime) throw new Error(FILE_CHANGED_ERROR)
      }
      await sftp.writeFile(target, Buffer.from(input.content, 'utf8'))
      const after = await sftp.stat(target)
      return { mtime: after.mtime * 1000, size: after.size }
    },

    download: async (_sender, id, rawPaths) => {
      const s = session(id)
      const paths = remotePathsSchema.parse(rawPaths).map((p) => remote(s, p))
      const sftp = await s.sftp()
      const parentWindow = dialogParent()
      const downloads = app.getPath('downloads')
      const first = paths[0]!
      if (paths.length === 1 && entryType((await sftp.stat(first)).mode) !== 'dir') {
        const options: Electron.SaveDialogOptions = { title: 'Guardar como', defaultPath: localJoin(downloads, basename(first)) }
        const result = parentWindow ? await dialog.showSaveDialog(parentWindow, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return []
        return [transfers.download(s, first, result.filePath)]
      }
      const options: Electron.OpenDialogOptions = {
        title: 'Descargar en…',
        buttonLabel: 'Descargar aquí',
        defaultPath: downloads,
        properties: ['openDirectory', 'createDirectory']
      }
      const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options)
      const dir = result.filePaths[0]
      if (result.canceled || !dir) return []
      const started = []
      for (const path of paths) started.push(transfers.download(s, path, await uniqueLocalPath(dir, basename(path))))
      return started
    },
    planUpload: async (_sender, id, rawDir, rawKind): Promise<UploadPlan | null> => {
      const s = session(id)
      const remoteDir = remote(s, rawDir)
      const kind = uploadKindSchema.parse(rawKind)
      const options: Electron.OpenDialogOptions = {
        title: kind === 'files' ? `Subir ficheros a ${remoteDir}` : `Subir carpeta a ${remoteDir}`,
        buttonLabel: 'Subir',
        properties: kind === 'files' ? ['openFile', 'multiSelections', 'showHiddenFiles'] : ['openDirectory', 'showHiddenFiles']
      }
      const parentWindow = dialogParent()
      const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) return null
      const sftp = await s.sftp()
      const names = result.filePaths.map((p) => localBasename(p))
      const conflicts: string[] = []
      for (const name of names) if (await sftp.exists(join(remoteDir, name))) conflicts.push(name)
      const token = randomUUID()
      pendingUploads.clear()
      pendingUploads.set(token, { serverId: s.config.id, remoteDir, localPaths: result.filePaths, conflicts: new Set(conflicts) })
      return { token, names, conflicts }
    },
    startUpload: async (_sender, rawToken, rawMode) => {
      const token = uuidSchema.parse(rawToken)
      const mode = uploadModeSchema.parse(rawMode)
      const plan = pendingUploads.get(token)
      pendingUploads.delete(token)
      if (!plan) throw new Error('La subida ya no está disponible: vuelve a elegir los ficheros')
      const s = sessions.get(plan.serverId)
      return plan.localPaths
        .filter((p) => mode === 'overwrite' || !plan.conflicts.has(localBasename(p)))
        .map((p) => transfers.upload(s, p, plan.remoteDir))
    },
    cancelTransfer: async (_sender, id) => transfers.cancel(uuidSchema.parse(id)),
    clearTransfers: async () => transfers.clearFinished(),
    listTransfers: async () => transfers.list(),
    showInFolder: async (_sender, id) => {
      const path = transfers.localPathOf(uuidSchema.parse(id))
      if (path) shell.showItemInFolder(path)
    },

    openTerminal: async (sender, id, rawTerminalId, rawCols, rawRows) => {
      const s = session(id)
      const terminalId = uuidSchema.parse(rawTerminalId)
      const { port1, port2 } = new MessageChannelMain()
      await startTerminal(
        s,
        {
          send: (message: TerminalToRenderer) => port1.postMessage(message),
          onMessage: (listener) => port1.on('message', (event) => listener(event.data)),
          onClose: (listener) => port1.on('close', listener),
          close: () => port1.close()
        },
        terminalSizeSchema.parse(rawCols),
        terminalSizeSchema.parse(rawRows)
      )
      port1.start()
      sender.postMessage(TERMINAL_PORT_EVENT, { terminalId }, [port2])
    },

    detectModules: async (_sender, raw) => {
      const input = saveServerSchema.parse(raw)
      // Si el servidor ya está conectado se usa esa conexión; si no, una temporal como en «Probar».
      if (input.config.id && sessions.isConnected(input.config.id)) return detectModules(sessions.get(input.config.id))
      const config: ServerConfig = { ...input.config, id: input.config.id ?? 'prueba' }
      const temporary = await sessions.openTemporary(config, await mergeSecrets(vault, input))
      try {
        return await detectModules(temporary)
      } finally {
        temporary.close()
      }
    },
    moduleCall: async (_sender, id, call, args) => {
      if (!isModuleCall(call)) throw new Error('Operación desconocida')
      return runModuleCall(session(id), call, args) as never
    },
    updaterState: async () => updater.get(),
    checkForUpdates: () => updater.check(true),
    downloadUpdate: () => updater.download(),
    installUpdate: async () => updater.install(),
    geoipStatus: () => geoip.status(),
    geoipDownload: () => geoip.download(),
    geoipLookup: async (_sender, ips) => geoip.lookup(z.array(z.string().max(64)).max(5000).parse(ips)),
    setSudoPassword: async (_sender, id, password) => {
      await setSudoPassword(session(id), z.string().min(1).max(1000).parse(password))
    }
  }

  for (const [method, handler] of Object.entries(handlers) as [ApiChannel, Handlers[ApiChannel]][]) {
    ipcMain.handle(channelName(method), async (event, ...args): Promise<IpcEnvelope<unknown>> => {
      // Solo responde a la ventana de la app (nunca a otro contenido que pudiera cargarse).
      const win = window()
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
        return { ok: false, error: 'Origen no permitido' }
      }
      try {
        return { ok: true, value: await handler(event.sender, ...args) }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    })
  }
}
