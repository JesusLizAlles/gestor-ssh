// Módulo de rendimiento: CPU, carga, memoria, red y disco.
// En directo se leen los contadores de /proc cada pocos segundos y se calculan las tasas entre dos lecturas;
// el histórico sale de sysstat (sar), que si está activo guarda una muestra cada 10 minutos.

/** Periodo del histórico, en horas. */
export type PerfHours = 6 | 24 | 168 | 720
export const PERF_HOURS = [6, 24, 168, 720] as const satisfies readonly PerfHours[]

/** Un punto de las gráficas. null = sin dato (contador reiniciado, actividad no recogida…). */
export interface PerfPoint {
  /** Milisegundos desde 1970. */
  t: number
  /** % de CPU ocupada (todo menos idle e iowait). */
  cpu: number | null
  /** % de CPU esperando a disco. */
  iowait: number | null
  load1: number | null
  load5: number | null
  load15: number | null
  /** % de memoria en uso (lo que no está disponible). */
  mem: number | null
  /** % de swap en uso. */
  swap: number | null
  /** Bytes por segundo. */
  netRx: number | null
  netTx: number | null
  diskRead: number | null
  diskWrite: number | null
}

export type PerfMetric = Exclude<keyof PerfPoint, 't'>

export interface DiskUsage {
  filesystem: string
  type: string
  mount: string
  size: number
  used: number
  available: number
}

/** Contadores en bruto de una lectura de /proc. */
export interface PerfSample {
  /** Hora local (ms) a la que llegó la lectura. */
  at: number
  /** Segundos desde el arranque (/proc/uptime): para medir el tiempo entre lecturas. */
  uptime: number
  cpus: number
  /** Campos de la línea «cpu» de /proc/stat (user nice system idle iowait irq softirq steal), en ticks. */
  cpu: number[]
  load: [number, number, number] | null
  memTotal: number
  memAvailable: number
  swapTotal: number
  swapFree: number
  /** Bytes acumulados recibidos/enviados por las interfaces de red (sin lo, docker, veth…). */
  netRx: number
  netTx: number
  /** Bytes acumulados leídos/escritos en los discos físicos. */
  diskRead: number
  diskWrite: number
  /** Solo si se pidió (df es más lento y cambia poco). */
  disks: DiskUsage[] | null
}

export type HistoryStatus = 'ok' | 'missing' | 'nodata'

export interface PerfHistory {
  /** missing = sysstat no está instalado; nodata = instalado pero sin datos en el periodo (¿desactivado?). */
  status: HistoryStatus
  points: PerfPoint[]
  /** Segundos entre muestras (mediana), o null si no hay. */
  interval: number | null
  /** La recogida de datos está activa (null = no se sabe). */
  collecting: boolean | null
  /** Errores de sadf al leer los ficheros (versión incompatible…). */
  warning: string | null
}

// ── /proc ──────────────────────────────────────────────────────────────────

/** Interfaces que no son tráfico real hacia fuera (o que lo duplican: puentes y pares de contenedores). */
const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|kube|vnet|tap|weave|lxc|lxdbr|podman)/

export const isCountedInterface = (name: string): boolean => !VIRTUAL_IFACE.test(name)

/** Discos enteros (no particiones, ni loop, ni device-mapper, que duplicarían lo del disco de debajo). */
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/

export const isWholeDisk = (name: string): boolean => WHOLE_DISK.test(name)

const num = (value: string | undefined): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** /proc/meminfo → kB por clave. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line)
    if (match) out[match[1]!] = Number(match[2])
  }
  return out
}

/** /proc/net/dev → bytes recibidos y enviados, sumando las interfaces que cuentan. */
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const name = line.slice(0, colon).trim()
    if (!name || name.includes('|') || !isCountedInterface(name)) continue
    const fields = line.slice(colon + 1).trim().split(/\s+/)
    if (fields.length < 9) continue
    rx += num(fields[0])
    tx += num(fields[8])
  }
  return { rx, tx }
}

/** /proc/diskstats → bytes leídos y escritos en los discos enteros (sectores de 512 bytes). */
export function parseDiskstats(text: string): { read: number; write: number } {
  let read = 0
  let write = 0
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || !isWholeDisk(fields[2]!)) continue
    read += num(fields[5]) * 512
    write += num(fields[9]) * 512
  }
  return { read, write }
}

/** Sistemas de ficheros que no son disco de verdad. */
const PSEUDO_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|efivarfs|ramfs|nsfs|fuse\.\w+|tracefs|debugfs|autofs|devpts|mqueue|hugetlbfs|securityfs|pstore|bpf|configfs|fusectl|binfmt_misc)$/

/** `df -P -k -T` → uso de cada sistema de ficheros real (sin repetidos). */
export function parseDf(text: string): DiskUsage[] {
  const seen = new Set<string>()
  const out: DiskUsage[] = []
  for (const line of text.split('\n').slice(1)) {
    const match = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim())
    if (!match) continue
    const [, filesystem, type, size, used, available, mount] = match as unknown as string[]
    if (PSEUDO_FS.test(type!) || Number(size) === 0 || mount!.startsWith('/snap/')) continue
    // El mismo dispositivo montado en varios sitios (bind mounts, subvolúmenes): una sola vez.
    if (seen.has(filesystem!)) continue
    seen.add(filesystem!)
    out.push({ filesystem: filesystem!, type: type!, mount: mount!, size: Number(size) * 1024, used: Number(used) * 1024, available: Number(available) * 1024 })
  }
  return out.sort((a, b) => a.mount.localeCompare(b.mount))
}

/** Salida del script de muestreo, ya dividida en secciones. */
export function parseSample(sections: Map<string, string>, at: number): PerfSample {
  const cpuLine = (sections.get('stat') ?? '').split('\n').find((l) => /^cpu\s/.test(l)) ?? ''
  const cpu = cpuLine.trim().split(/\s+/).slice(1, 9).map(num)
  const loadFields = (sections.get('load') ?? '').trim().split(/\s+/)
  const load: PerfSample['load'] = loadFields.length >= 3 ? [num(loadFields[0]), num(loadFields[1]), num(loadFields[2])] : null
  const mem = parseMeminfo(sections.get('mem') ?? '')
  const memTotal = (mem.MemTotal ?? 0) * 1024
  // Núcleos antiguos (< 3.14) no tienen MemAvailable.
  const memAvailable = (mem.MemAvailable ?? (mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0)) * 1024
  const net = parseNetDev(sections.get('net') ?? '')
  const disk = parseDiskstats(sections.get('disk') ?? '')
  return {
    at,
    uptime: num((sections.get('uptime') ?? '').trim().split(/\s+/)[0]),
    cpus: Math.max(1, num((sections.get('cpus') ?? '').trim())),
    cpu,
    load,
    memTotal,
    memAvailable,
    swapTotal: (mem.SwapTotal ?? 0) * 1024,
    swapFree: (mem.SwapFree ?? 0) * 1024,
    netRx: net.rx,
    netTx: net.tx,
    diskRead: disk.read,
    diskWrite: disk.write,
    disks: sections.has('df') ? parseDf(sections.get('df') ?? '') : null
  }
}

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

/** Punto de las gráficas a partir de dos lecturas seguidas. Sin la anterior, solo lo que no son tasas. */
export function pointFromSamples(previous: PerfSample | null, current: PerfSample): PerfPoint {
  const memPct = current.memTotal > 0 ? round(((current.memTotal - current.memAvailable) / current.memTotal) * 100) : null
  const swapPct = current.swapTotal > 0 ? round(((current.swapTotal - current.swapFree) / current.swapTotal) * 100) : null
  const point: PerfPoint = {
    t: current.at,
    cpu: null,
    iowait: null,
    load1: current.load?.[0] ?? null,
    load5: current.load?.[1] ?? null,
    load15: current.load?.[2] ?? null,
    mem: memPct,
    swap: swapPct,
    netRx: null,
    netTx: null,
    diskRead: null,
    diskWrite: null
  }
  if (!previous) return point
  // El tiempo entre lecturas se mide en el servidor; si se reinició (uptime menor), no hay tasas.
  const seconds = current.uptime - previous.uptime
  if (!(seconds > 0)) return point
  const rate = (now: number, before: number) => (now >= before ? round((now - before) / seconds, 0) : null)
  point.netRx = rate(current.netRx, previous.netRx)
  point.netTx = rate(current.netTx, previous.netTx)
  point.diskRead = rate(current.diskRead, previous.diskRead)
  point.diskWrite = rate(current.diskWrite, previous.diskWrite)

  const delta = current.cpu.map((v, i) => v - (previous.cpu[i] ?? 0))
  const total = delta.reduce((a, b) => a + b, 0)
  if (total > 0 && delta.every((d) => d >= 0)) {
    const idle = (delta[3] ?? 0) + (delta[4] ?? 0)
    point.cpu = round(((total - idle) / total) * 100, 1)
    point.iowait = round(((delta[4] ?? 0) / total) * 100, 1)
  }
  return point
}

// ── sysstat (sadf -d) ──────────────────────────────────────────────────────

type SarKind = 'cpu' | 'load' | 'mem' | 'swap' | 'net' | 'disk'

function sarKind(columns: string[]): SarKind | null {
  if (columns.includes('%idle')) return 'cpu'
  if (columns.includes('ldavg-1')) return 'load'
  if (columns.includes('%memused')) return 'mem'
  if (columns.includes('%swpused')) return 'swap'
  if (columns.includes('IFACE') && columns.includes('rxkB/s')) return 'net'
  if (columns.includes('bread/s')) return 'disk'
  return null
}

/** «2026-11-13 04:10:01 UTC» (sadf -d escribe en UTC) → ms. */
function sarTime(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value.trim())
  if (!match) return null
  const ms = Date.parse(`${match[1]}T${match[2]}Z`)
  return Number.isFinite(ms) ? ms : null
}

const emptyPoint = (t: number): PerfPoint => ({
  t,
  cpu: null,
  iowait: null,
  load1: null,
  load5: null,
  load15: null,
  mem: null,
  swap: null,
  netRx: null,
  netTx: null,
  diskRead: null,
  diskWrite: null
})

/**
 * Salida de `sadf -d fichero -- -u -q -r -S -n DEV -b` (de uno o varios ficheros seguidos): bloques
 * con una cabecera «# hostname;interval;timestamp;…» y filas separadas por «;». Las columnas se buscan
 * por su nombre porque cambian entre versiones de sysstat.
 */
export function parseSadf(output: string): { points: PerfPoint[]; interval: number | null } {
  const byTime = new Map<number, PerfPoint>()
  const intervals: number[] = []
  let columns: string[] = []
  let kind: SarKind | null = null
  let col: Record<string, number> = {}

  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      columns = line.replace(/^#\s*/, '').split(';')
      kind = sarKind(columns)
      col = Object.fromEntries(columns.map((c, i) => [c, i]))
      continue
    }
    if (!kind) continue
    const fields = line.split(';')
    // Las líneas LINUX-RESTART y las de otros formatos no tienen todas las columnas.
    if (fields.length !== columns.length) continue
    const t = sarTime(fields[col.timestamp ?? 2] ?? '')
    if (t === null) continue
    const value = (name: string): number | null => {
      const index = col[name]
      if (index === undefined) return null
      const n = Number(fields[index])
      return Number.isFinite(n) ? n : null
    }
    const point = byTime.get(t) ?? emptyPoint(t)
    byTime.set(t, point)

    if (kind === 'cpu') {
      const cpu = fields[col.CPU ?? 3]
      if (cpu !== '-1' && cpu !== 'all') continue
      const idle = value('%idle')
      const iowait = value('%iowait')
      if (idle !== null) point.cpu = round(Math.max(0, 100 - idle - (iowait ?? 0)), 1)
      if (iowait !== null) point.iowait = round(iowait, 1)
      const interval = value('interval')
      if (interval && interval > 0) intervals.push(interval)
    } else if (kind === 'load') {
      point.load1 = value('ldavg-1')
      point.load5 = value('ldavg-5')
      point.load15 = value('ldavg-15')
    } else if (kind === 'mem') {
      const pct = value('%memused')
      const used = value('kbmemused')
      const avail = value('kbavail')
      // Se calcula igual que en directo (lo no disponible) si hay datos para ello: según la versión,
      // %memused cuenta o no la caché como usada.
      if (pct && used && avail !== null) {
        const total = (used * 100) / pct
        point.mem = round(Math.min(100, Math.max(0, ((total - avail) / total) * 100)))
      } else point.mem = pct
    } else if (kind === 'swap') {
      point.swap = value('%swpused')
    } else if (kind === 'net') {
      const iface = fields[col.IFACE!] ?? ''
      if (!isCountedInterface(iface)) continue
      const rx = value('rxkB/s')
      const tx = value('txkB/s')
      if (rx !== null) point.netRx = round((point.netRx ?? 0) + rx * 1024, 0)
      if (tx !== null) point.netTx = round((point.netTx ?? 0) + tx * 1024, 0)
    } else if (kind === 'disk') {
      // Bloques de 512 bytes por segundo.
      const read = value('bread/s')
      const write = value('bwrtn/s')
      if (read !== null) point.diskRead = round(read * 512, 0)
      if (write !== null) point.diskWrite = round(write * 512, 0)
    }
  }
  const sorted = intervals.sort((a, b) => a - b)
  return {
    points: [...byTime.values()].sort((a, b) => a.t - b.t),
    interval: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null
  }
}

// ── Resúmenes (para Claude y las tarjetas) ─────────────────────────────────

export interface MetricSummary {
  avg: number | null
  max: number | null
  /** Momento del máximo (ms). */
  maxAt: number | null
  last: number | null
}

export function summarize(points: PerfPoint[], metric: PerfMetric): MetricSummary {
  let sum = 0
  let count = 0
  let max: number | null = null
  let maxAt: number | null = null
  let last: number | null = null
  for (const p of points) {
    const v = p[metric]
    if (v === null) continue
    sum += v
    count++
    last = v
    if (max === null || v > max) {
      max = v
      maxAt = p.t
    }
  }
  return { avg: count ? round(sum / count) : null, max, maxAt, last }
}

/** Reduce una serie a `buckets` tramos con la media de cada uno. */
export function downsample(points: PerfPoint[], buckets: number): PerfPoint[] {
  if (points.length <= buckets) return points
  const start = points[0]!.t
  const span = points[points.length - 1]!.t - start || 1
  const groups: PerfPoint[][] = Array.from({ length: buckets }, () => [])
  for (const p of points) groups[Math.min(buckets - 1, Math.floor(((p.t - start) / span) * buckets))]!.push(p)
  const metrics = Object.keys(emptyPoint(0)).filter((k) => k !== 't') as PerfMetric[]
  return groups
    .filter((g) => g.length)
    .map((g) => {
      const out = emptyPoint(g[0]!.t)
      for (const m of metrics) {
        const values = g.map((p) => p[m]).filter((v): v is number => v !== null)
        if (!values.length) continue
        out[m] = round(values.reduce((a, b) => a + b, 0) / values.length)
      }
      return out
    })
}
