// Módulos de administración: vistas extra por servidor (servicios, Apache, MySQL…).
// Aquí van los tipos que comparten los dos procesos y los analizadores de la salida de los comandos.

export type ModuleId = 'services' | 'apache' | 'mysql'

export interface ModuleInfo {
  id: ModuleId
  name: string
  description: string
}

export const MODULES: readonly ModuleInfo[] = [
  { id: 'services', name: 'Servicios', description: 'Servicios de systemd: estado, arrancar, parar, reiniciar, habilitar y registro.' },
  { id: 'apache', name: 'Apache', description: 'Estado, prueba de configuración, sitios (activar/desactivar), módulos y registro de errores.' },
  { id: 'mysql', name: 'MySQL / MariaDB', description: 'Estado del servicio, bases de datos con su tamaño, procesos en curso, configuración y registro.' }
]

export const moduleInfo = (id: ModuleId): ModuleInfo => MODULES.find((m) => m.id === id)!

/** Mensaje de error con el que el proceso principal pide la contraseña de sudo. */
export const SUDO_PASSWORD_REQUIRED = 'Hace falta la contraseña de sudo'

// ── Servicios ──────────────────────────────────────────────────────────────

export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'

export interface ServiceUnit {
  name: string
  /** loaded, not-found, masked… */
  load: string
  /** active, inactive, failed, activating… */
  active: string
  /** running, exited, dead… */
  sub: string
  description: string
  /** enabled, disabled, static, masked… (null si no tiene fichero de unidad). */
  enabled: string | null
}

export interface ServiceDetail {
  name: string
  description: string
  active: string
  sub: string
  enabled: string
  /** Desde cuándo está en el estado actual (texto de systemd), o vacío. */
  since: string
  mainPid: number | null
  memory: number | null
  fragmentPath: string
}

export interface LogResult {
  text: string
  /** El usuario no ve todo el registro (no está en el grupo adm/systemd-journal): conviene sudo. */
  limited: boolean
}

// ── Apache ─────────────────────────────────────────────────────────────────

export interface ApacheSite {
  name: string
  path: string
  enabled: boolean
}

export interface ApacheOverview {
  installed: boolean
  ctl: string | null
  service: string | null
  version: string
  /** debian = sites-available/sites-enabled con a2ensite; redhat = conf.d. */
  layout: 'debian' | 'redhat' | 'other'
  configFiles: string[]
  sites: ApacheSite[]
  errorLogs: string[]
}

export type ApacheReport = 'configtest' | 'vhosts' | 'modules'

export interface CommandReport {
  ok: boolean
  text: string
}

// ── MySQL / MariaDB ────────────────────────────────────────────────────────

export interface MysqlOverview {
  installed: boolean
  /** Cliente de línea de comandos (mariadb o mysql). */
  client: string | null
  service: string | null
  version: string
  configFiles: string[]
  errorLogs: string[]
}

export type MysqlQuery = 'databases' | 'status' | 'processlist'

export interface TableResult {
  columns: string[]
  rows: (string | null)[][]
}

// ── Llamadas de los módulos (un canal IPC para todas) ─────────────────────

export interface ModuleCalls {
  'services.list': { args: Record<string, never>; result: ServiceUnit[] }
  'services.show': { args: { unit: string }; result: ServiceDetail }
  'services.logs': { args: { unit: string; lines: number; sudo: boolean }; result: LogResult }
  'services.action': { args: { unit: string; action: ServiceAction }; result: ServiceDetail }
  'files.tail': { args: { path: string; lines: number }; result: LogResult }
  'apache.overview': { args: Record<string, never>; result: ApacheOverview }
  'apache.report': { args: { report: ApacheReport }; result: CommandReport }
  'apache.site': { args: { name: string; enable: boolean }; result: CommandReport }
  'mysql.overview': { args: Record<string, never>; result: MysqlOverview }
  'mysql.query': { args: { query: MysqlQuery; sudo: boolean }; result: TableResult }
  'mysql.kill': { args: { id: number; sudo: boolean }; result: void }
}

export type ModuleCall = keyof ModuleCalls

// ── Analizadores ───────────────────────────────────────────────────────────

/** Divide la salida en bloques separados por una línea `@@<nombre>`. */
export function splitSections(output: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current = ''
  let lines: string[] = []
  for (const line of output.split('\n')) {
    const match = /^@@(\w+)$/.exec(line)
    if (match) {
      sections.set(current, lines.join('\n'))
      current = match[1]!
      lines = []
    } else lines.push(line)
  }
  sections.set(current, lines.join('\n'))
  return sections
}

/**
 * `systemctl list-units --type=service --all --plain --no-legend` y `systemctl list-unit-files
 * --type=service --no-legend`, combinados: aparecen también los servicios instalados que no están cargados.
 */
export function parseServices(listUnits: string, unitFiles: string): ServiceUnit[] {
  const units = new Map<string, ServiceUnit>()
  for (const raw of listUnits.split('\n')) {
    // Los fallidos pueden venir con «●» delante aunque se pida --plain.
    const line = raw.replace(/^\s*[●*]\s*/, '').trim()
    const match = /^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!match) continue
    units.set(match[1]!, { name: match[1]!, load: match[2]!, active: match[3]!, sub: match[4]!, description: match[5]!.trim(), enabled: null })
  }
  for (const raw of unitFiles.split('\n')) {
    const match = /^(\S+\.service)\s+(\S+)/.exec(raw.trim())
    if (!match) continue
    const [, name, state] = match as unknown as [string, string, string]
    // Las plantillas (nombre@.service) no son servicios que se puedan arrancar tal cual.
    if (name.endsWith('@.service')) continue
    const unit = units.get(name)
    if (unit) unit.enabled = state
    else units.set(name, { name, load: 'loaded', active: 'inactive', sub: 'dead', description: '', enabled: state })
  }
  return [...units.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Salida de `systemctl show -p A,B,C` → objeto. */
export function parseKeyValues(output: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

export function parseServiceDetail(name: string, output: string): ServiceDetail {
  const kv = parseKeyValues(output)
  const number = (value: string | undefined) => {
    const n = Number(value)
    // systemd usa [not set] o el máximo de uint64 cuando no hay dato.
    return value && Number.isFinite(n) && n > 0 && n < 2 ** 53 ? n : null
  }
  return {
    name: kv.Id || name,
    description: kv.Description ?? '',
    active: kv.ActiveState ?? 'unknown',
    sub: kv.SubState ?? '',
    enabled: kv.UnitFileState ?? '',
    since: (kv.ActiveState === 'active' ? kv.ActiveEnterTimestamp : kv.InactiveEnterTimestamp) ?? '',
    mainPid: number(kv.MainPID),
    memory: number(kv.MemoryCurrent),
    fragmentPath: kv.FragmentPath ?? ''
  }
}

/** Líneas `clave=valor` en las que una clave puede repetirse (config=…, site=…). */
export function parseMulti(output: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    out.set(key, [...(out.get(key) ?? []), line.slice(eq + 1)])
  }
  return out
}

const basenameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function parseApacheOverview(output: string): ApacheOverview {
  const kv = parseMulti(output)
  const first = (key: string) => kv.get(key)?.[0] ?? null
  const root = first('root')
  const sites = (kv.get('site') ?? []).map((line) => {
    const path = line.slice(2)
    return { name: basenameOf(path), path, enabled: line.startsWith('1') }
  })
  return {
    installed: first('installed') === '1',
    ctl: first('ctl'),
    service: first('service'),
    version: (first('version') ?? '').replace(/^Server version:\s*/, ''),
    layout: root === '/etc/apache2' && kv.has('debian') ? 'debian' : root === '/etc/httpd' ? 'redhat' : 'other',
    configFiles: kv.get('config') ?? [],
    sites,
    errorLogs: kv.get('errorlog') ?? []
  }
}

export function parseMysqlOverview(output: string): MysqlOverview {
  const kv = parseMulti(output)
  const first = (key: string) => kv.get(key)?.[0] ?? null
  return {
    installed: first('installed') === '1',
    client: first('client'),
    service: first('service'),
    version: first('version') ?? '',
    configFiles: kv.get('config') ?? [],
    errorLogs: kv.get('errorlog') ?? []
  }
}

/** Deshace los escapes de `mysql --batch` (\t, \n, \\, \0) y convierte NULL. */
function unescapeBatch(value: string): string | null {
  if (value === 'NULL') return null
  return value.replace(/\\([tn0\\])/g, (_m, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '\0' : '\\'))
}

/** Salida de `mysql --batch` (con cabecera): columnas separadas por tabuladores. */
export function parseMysqlBatch(output: string): TableResult {
  const lines = output.split('\n').filter((l) => l.length > 0)
  const [header, ...rows] = lines
  if (!header) return { columns: [], rows: [] }
  return { columns: header.split('\t'), rows: rows.map((r) => r.split('\t').map(unescapeBatch)) }
}

/** ¿Es un nombre de unidad de systemd razonable? (letras, números y @ . _ : - \). */
export const isUnitName = (name: string): boolean => /^[A-Za-z0-9@._:\\-]{1,250}\.service$/.test(name)

/** Nombre de sitio de Apache (fichero de sites-available). */
export const isSiteName = (name: string): boolean => /^[A-Za-z0-9._-]{1,200}$/.test(name) && name !== '.' && name !== '..'
