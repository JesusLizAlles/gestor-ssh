import type { ModuleCall, ModuleCalls, ModuleId } from './modules'

export type Environment = 'dev' | 'test' | 'prod'
export type AuthMethod = 'password' | 'privateKey' | 'agent'

/** Servidor guardado. Las contraseñas y frases de paso van aparte, cifradas. */
export interface ServerConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  /** Ruta local de la clave privada (solo con authMethod = privateKey). */
  privateKeyPath: string
  environment: Environment
  /** Carpeta en la que se abre el explorador; vacío = la carpeta personal del usuario. */
  initialPath: string
  /** Módulos de administración activados para este servidor. */
  modules: ModuleId[]
}

export type SecretKey = 'password' | 'passphrase'
/** string = nuevo valor; null = olvidar el guardado; ausente = no tocarlo. */
export type SecretsPatch = Partial<Record<SecretKey, string | null>>

export interface ServerSummary extends ServerConfig {
  storedSecrets: SecretKey[]
}

export interface SaveServerInput {
  config: Omit<ServerConfig, 'id'> & { id?: string }
  secrets?: SecretsPatch
}

export interface SecretStorageStatus {
  /** false = no hay llavero del sistema: los secretos solo duran mientras la app está abierta. */
  persistent: boolean
  backend: string
}

export interface ConnectResult {
  fingerprint: string
  /** Carpeta personal del usuario en el servidor (ruta absoluta). */
  home: string
}

export interface TestResult extends ConnectResult {
  /** Salida de `uname -srm` si el servidor permite ejecutar comandos. */
  system: string | null
}

export type EntryType = 'dir' | 'file' | 'link' | 'other'

export interface RemoteEntry {
  name: string
  path: string
  type: EntryType
  /** Para enlaces simbólicos: a qué apuntan (dir/file) si se pudo resolver. */
  linkTarget?: EntryType
  size: number
  /** Milisegundos desde 1970. */
  mtime: number
  /** Bits de permisos (st_mode & 0o7777). */
  mode: number
  uid: number
  gid: number
  /** Nombres de usuario y grupo si el servidor los da (OpenSSH sí); si no, los números. */
  owner: string
  group: string
}

export interface DirListing {
  path: string
  entries: RemoteEntry[]
}

export interface RemoteFile {
  path: string
  content: string
  size: number
  mtime: number
}

export interface SaveFileInput {
  serverId: string
  path: string
  content: string
  /** mtime que se leyó; si el fichero cambió desde entonces se avisa en lugar de pisarlo. */
  expectedMtime: number | null
  /** Escribir como root (sudo). */
  sudo?: boolean
}

export type TransferDirection = 'download' | 'upload'
export type TransferState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface TransferInfo {
  id: string
  serverId: string
  serverName: string
  direction: TransferDirection
  /** Nombre que se enseña (fichero o carpeta). */
  name: string
  /** Carpeta de destino, para mostrarla. */
  destination: string
  totalBytes: number
  doneBytes: number
  totalFiles: number
  doneFiles: number
  state: TransferState
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface UploadPlan {
  token: string
  names: string[]
  /** Los que ya existen en la carpeta de destino. */
  conflicts: string[]
}

export interface HostKeyRequest {
  requestId: string
  host: string
  port: number
  fingerprint: string
}

export interface SessionEvent {
  serverId: string
  /** El servidor se desconectó solo (red, reinicio…). */
  kind: 'closed'
  reason: string
}

export interface ServerApi {
  secretStorageStatus(): Promise<SecretStorageStatus>
  listServers(): Promise<ServerSummary[]>
  saveServer(input: SaveServerInput): Promise<ServerSummary>
  deleteServer(id: string): Promise<void>
  pickPrivateKey(): Promise<string | null>
  testServer(input: SaveServerInput): Promise<TestResult>
  connect(id: string): Promise<ConnectResult>
  disconnect(id: string): Promise<void>
  respondHostKey(requestId: string, accept: boolean): Promise<void>
  forgetHostKey(serverId: string): Promise<void>

  listDir(serverId: string, path: string): Promise<DirListing>
  makeDir(serverId: string, path: string): Promise<void>
  rename(serverId: string, from: string, to: string): Promise<void>
  remove(serverId: string, paths: string[]): Promise<void>
  createFile(serverId: string, path: string): Promise<void>
  readTextFile(serverId: string, path: string, sudo?: boolean): Promise<RemoteFile>
  saveTextFile(input: SaveFileInput): Promise<{ mtime: number; size: number }>

  download(serverId: string, paths: string[]): Promise<TransferInfo[]>
  planUpload(serverId: string, remoteDir: string, kind: 'files' | 'folder'): Promise<UploadPlan | null>
  /** `skip` = no subir los que ya existen; `overwrite` = sustituirlos (las carpetas se fusionan). */
  startUpload(token: string, mode: 'overwrite' | 'skip'): Promise<TransferInfo[]>
  cancelTransfer(id: string): Promise<void>
  clearTransfers(): Promise<void>
  listTransfers(): Promise<TransferInfo[]>
  showInFolder(transferId: string): Promise<void>

  openTerminal(serverId: string, terminalId: string, cols: number, rows: number): Promise<void>

  /** Conecta (o usa la conexión abierta) y mira qué módulos tienen sentido en el servidor. */
  detectModules(input: SaveServerInput): Promise<ModuleId[]>
  moduleCall<K extends ModuleCall>(serverId: string, call: K, args: ModuleCalls[K]['args']): Promise<ModuleCalls[K]['result']>
  /** Comprueba la contraseña de sudo y la guarda en memoria mientras dure la conexión. */
  setSudoPassword(serverId: string, password: string): Promise<void>

  geoipStatus(): Promise<GeoIpStatus>
  /** Descarga (o actualiza) la base de datos de países de DB-IP. */
  geoipDownload(): Promise<GeoIpStatus>
  /** Código ISO del país de cada IP, consultado en local. */
  geoipLookup(ips: string[]): Promise<Record<string, string | null>>

  onHostKey(listener: (request: HostKeyRequest) => void): () => void
  onTransfer(listener: (transfer: TransferInfo) => void): () => void
  onSession(listener: (event: SessionEvent) => void): () => void
}

/** Mensajes por el MessagePort de cada terminal. */
export type TerminalToMain =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  /** El renderer ya pintó estos bytes: el principal puede seguir enviando. */
  | { type: 'ack'; bytes: number }
  | { type: 'close' }

export type TerminalToRenderer = { type: 'data'; data: Uint8Array } | { type: 'exit'; reason: string }

/** Base de datos local de países (DB-IP «IP to Country Lite»). */
export interface GeoIpStatus {
  available: boolean
  /** Fecha de la versión (ms), según la propia base de datos. */
  builtAt: number | null
  sizeBytes: number
  /** Tiene más de mes y medio: conviene actualizarla. */
  outdated: boolean
}

/** Mensaje de error al guardar un fichero que otro modificó mientras estaba abierto. */
export const FILE_CHANGED_ERROR = 'El fichero ha cambiado en el servidor desde que lo abriste'

/** Ficheros más grandes no se abren en el editor. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024
