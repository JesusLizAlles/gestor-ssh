// Módulo de seguridad: tipos y analizadores de `ss`, registros de sshd, `who` y fail2ban.

export interface SocketEntry {
  proto: 'tcp' | 'udp'
  /** ESTAB, LISTEN, TIME-WAIT, UNCONN… */
  state: string
  localAddress: string
  localPort: string
  peerAddress: string
  peerPort: string
  /** Nombre del proceso (solo si se ve: los de otros usuarios necesitan sudo). */
  process: string | null
  pid: number | null
}

export interface ConnectionsResult {
  sockets: SocketEntry[]
  /** IP desde la que está conectada esta app, tal como la ve el servidor. */
  clientIp: string | null
}

export type SshEventKind = 'failed' | 'invalid' | 'accepted'

export interface SshEvent {
  time: string
  kind: SshEventKind
  user: string
  ip: string
  /** password, publickey… (en fallidos y aceptados). */
  method: string | null
  pid: number | null
}

export interface SshLogResult {
  events: SshEvent[]
  /** De dónde salió: journal o la ruta del fichero. */
  source: string
}

export interface FailureSummary {
  ip: string
  attempts: number
  users: string[]
  first: string
  last: string
}

export interface WhoEntry {
  user: string
  tty: string
  since: string
  from: string
}

export interface SessionsResult {
  who: WhoEntry[]
  last: string
}

export interface JailStatus {
  name: string
  currentlyFailed: number
  totalFailed: number
  currentlyBanned: number
  totalBanned: number
  bannedIps: string[]
}

export interface Fail2banResult {
  installed: boolean
  /** fail2ban instalado pero el servicio no responde. */
  error: string | null
  jails: JailStatus[]
}

export interface FirewallResult {
  tool: 'ufw' | 'firewalld' | 'nftables' | 'iptables' | null
  /** true/false si se sabe; null si no se puede deducir. */
  active: boolean | null
  text: string
}

export type SshPeriod = 24 | 168 | 720

// ── Direcciones ────────────────────────────────────────────────────────────

/** `1.2.3.4:22`, `[::1]:22`, `*:22`, `[::ffff:1.2.3.4]:22`, `0.0.0.0%eth0:68` → dirección y puerto. */
export function splitHostPort(value: string): { address: string; port: string } {
  const index = value.lastIndexOf(':')
  if (index < 0) return { address: value, port: '' }
  let address = value.slice(0, index)
  const port = value.slice(index + 1)
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  address = address.replace(/%.*$/, '')
  // IPv4 dentro de IPv6 (sockets de doble pila): se enseña como IPv4.
  address = address.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1')
  return { address, port }
}

export function isLoopback(address: string): boolean {
  return /^127\./.test(address) || address === '::1' || address === 'localhost'
}

export function isWildcard(address: string): boolean {
  return address === '*' || address === '0.0.0.0' || address === '::' || address === ''
}

/** Multidifusión (224.0.0.0/4 y ff00::/8): mDNS, SSDP… no es una IP de Internet. */
export function isMulticast(address: string): boolean {
  const first = Number(/^(\d+)\./.exec(address)?.[1])
  return (first >= 224 && first <= 239) || /^ff[0-9a-f]{2}:/i.test(address)
}

/** Redes privadas, locales y de enlace: no vienen de Internet. */
export function isPrivate(address: string): boolean {
  if (isLoopback(address)) return true
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  return /^(fc|fd|fe80)/i.test(address)
}

// ── ss ─────────────────────────────────────────────────────────────────────

/** Salida de `ss -Htuanp`: Netid State Recv-Q Send-Q Local Peer [Process]. */
export function parseSs(output: string): SocketEntry[] {
  const entries: SocketEntry[] = []
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 6) continue
    const [netid, state, , , local, peer, ...rest] = fields as [string, string, string, string, string, string, ...string[]]
    if (netid !== 'tcp' && netid !== 'udp') continue
    const processInfo = rest.join(' ')
    const proc = /\(\("([^"]+)",pid=(\d+)/.exec(processInfo)
    const l = splitHostPort(local)
    const p = splitHostPort(peer)
    entries.push({
      proto: netid,
      state,
      localAddress: l.address,
      localPort: l.port,
      peerAddress: p.address,
      peerPort: p.port,
      process: proc ? proc[1]! : null,
      pid: proc ? Number(proc[2]) : null
    })
  }
  return entries
}

/** Sockets que esperan conexiones: LISTEN en TCP y UNCONN en UDP. */
export const isListening = (s: SocketEntry): boolean => (s.proto === 'tcp' ? s.state === 'LISTEN' : s.state === 'UNCONN')

// ── Registro de sshd ───────────────────────────────────────────────────────

// «2026-11-09T10:14:29+0100 host sshd[123]: …» (journal) o «Nov  9 10:14:29 host sshd[123]: …» (syslog).
const LINE = /^(\S+(?:\s+\d+\s+[\d:]+)?)\s+\S+\s+sshd(?:-session)?\[(\d+)\]:\s+(.*)$/

/** Eventos de autenticación de sshd: fallidos, usuarios que no existen y accesos correctos. */
export function parseSshLog(text: string): SshEvent[] {
  const events: SshEvent[] = []
  for (const line of text.split('\n')) {
    const match = LINE.exec(line.trim())
    if (!match) continue
    const [, time, pid, message] = match as unknown as [string, string, string, string]
    let m: RegExpExecArray | null
    if ((m = /^Failed (\S+) for (?:invalid user )?(\S*) from (\S+) port/.exec(message))) {
      events.push({ time, kind: 'failed', method: m[1]!, user: m[2]!, ip: m[3]!, pid: Number(pid) })
    } else if ((m = /^Invalid user (\S*) from (\S+)/.exec(message))) {
      events.push({ time, kind: 'invalid', method: null, user: m[1]!, ip: m[2]!, pid: Number(pid) })
    } else if ((m = /^Accepted (\S+) for (\S+) from (\S+) port/.exec(message))) {
      events.push({ time, kind: 'accepted', method: m[1]!, user: m[2]!, ip: m[3]!, pid: Number(pid) })
    }
  }
  return events
}

/**
 * Intentos fallidos por IP. Un «Invalid user» suele ir seguido de «Failed password for invalid
 * user» en la misma conexión (mismo PID): solo cuenta si esa conexión no dejó ningún «Failed».
 */
export function summarizeFailures(events: SshEvent[]): FailureSummary[] {
  const pidsWithFailed = new Set(events.filter((e) => e.kind === 'failed').map((e) => `${e.ip}#${e.pid}`))
  const byIp = new Map<string, FailureSummary & { userSet: Set<string> }>()
  for (const e of events) {
    if (e.kind === 'accepted') continue
    if (e.kind === 'invalid' && pidsWithFailed.has(`${e.ip}#${e.pid}`)) continue
    const entry = byIp.get(e.ip) ?? { ip: e.ip, attempts: 0, users: [], userSet: new Set<string>(), first: e.time, last: e.time }
    entry.attempts++
    if (e.user) entry.userSet.add(e.user)
    entry.last = e.time
    byIp.set(e.ip, entry)
  }
  return [...byIp.values()]
    .map(({ userSet, ...rest }) => ({ ...rest, users: [...userSet] }))
    .sort((a, b) => b.attempts - a.attempts || a.ip.localeCompare(b.ip))
}

// ── who ────────────────────────────────────────────────────────────────────

/** Salida de `who`: «ana  pts/0  2026-11-09 10:00 (1.2.3.4)». */
export function parseWho(output: string): WhoEntry[] {
  const entries: WhoEntry[] = []
  for (const line of output.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+(.+?)(?:\s+\((.*)\))?\s*$/.exec(line)
    if (!match) continue
    entries.push({ user: match[1]!, tty: match[2]!, since: match[3]!.trim(), from: match[4] ?? '' })
  }
  return entries
}

// ── fail2ban ───────────────────────────────────────────────────────────────

const statNumber = (text: string, label: string): number => Number(new RegExp(`${label}:\\s*(\\d+)`).exec(text)?.[1] ?? 0)

/** Salida de `fail2ban-client status <jail>`. */
export function parseJail(name: string, text: string): JailStatus {
  const banned = /Banned IP list:[ \t]*(.*)/.exec(text)?.[1]?.trim() ?? ''
  return {
    name,
    currentlyFailed: statNumber(text, 'Currently failed'),
    totalFailed: statNumber(text, 'Total failed'),
    currentlyBanned: statNumber(text, 'Currently banned'),
    totalBanned: statNumber(text, 'Total banned'),
    bannedIps: banned ? banned.split(/\s+/) : []
  }
}

/** Lista de jails de `fail2ban-client status` («Jail list: sshd, nginx-http-auth»). */
export function parseJailList(text: string): string[] {
  const list = /Jail list:[ \t]*(.*)/.exec(text)?.[1]?.trim() ?? ''
  return list ? list.split(/[,\s]+/).filter(Boolean) : []
}

/** Nombre de jail razonable (letras, números, guiones, puntos y subrayados). */
export const isJailName = (name: string): boolean => /^[\w.-]{1,100}$/.test(name)
