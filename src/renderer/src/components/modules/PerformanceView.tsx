import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatRate, formatSize } from '@shared/format'
import { pointFromSamples, summarize, type PerfHistory, type PerfHours, type PerfMetric, type PerfPoint, type PerfSample } from '@shared/performance'
import type { ServerSummary } from '@shared/types'
import { useModuleCall } from '../../lib/sudo'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { clockLabel, dayLabel } from '@shared/chart-scale'
import { SERIES_COLORS, TimeChart, type ChartSeries } from './TimeChart'

type Range = 'live' | PerfHours

const RANGES: [Range, string][] = [
  ['live', 'En directo'],
  [6, '6 horas'],
  [24, '24 horas'],
  [168, '7 días'],
  [720, '30 días']
]

/** Segundos entre lecturas en directo, y cuánto se guarda (una hora). */
const LIVE_EVERY = 5_000
const LIVE_KEEP = 720
/** df cada tantas lecturas (cambia poco y es lo más lento). */
const DF_EVERY = 12

const [BLUE, ORANGE, AQUA] = SERIES_COLORS

const fmtNumber = (v: number, digits = 1) => v.toLocaleString('es-ES', { maximumFractionDigits: digits })
const fmtPct = (v: number) => `${fmtNumber(v)} %`
const fmtAxisPct = (v: number) => `${fmtNumber(v, 0)} %`
const fmtLoad = (v: number) => fmtNumber(v, 2)
const fmtAxisRate = (v: number) => (v === 0 ? '0' : formatSize(v))

function fmtUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return `${days} d ${hours} h`
  if (hours) return `${hours} h ${minutes} min`
  return `${minutes} min`
}

function readStoredRange(key: string): Range | null {
  try {
    const value = localStorage.getItem(key)
    if (value === 'live') return 'live'
    const n = Number(value)
    return n === 6 || n === 24 || n === 168 || n === 720 ? n : null
  } catch {
    return null
  }
}

function storeRange(key: string, range: Range): void {
  try {
    localStorage.setItem(key, String(range))
  } catch {
    // Sin almacenamiento: se recuerda mientras dure la pestaña.
  }
}

/** Lecturas en directo: una cada LIVE_EVERY mientras la vista esté abierta (aunque la pestaña no se vea). */
function useLiveSamples(call: ReturnType<typeof useModuleCall>) {
  const [points, setPoints] = useState<PerfPoint[]>([])
  const [sample, setSample] = useState<PerfSample | null>(null)
  const [disks, setDisks] = useState<PerfSample['disks']>(null)
  const [error, setError] = useState<string | null>(null)
  const previous = useRef<PerfSample | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let count = 0
    const tick = async () => {
      const started = Date.now()
      try {
        const current = await call('performance.sample', { disks: count % DF_EVERY === 0 })
        if (stopped) return
        count++
        const point = pointFromSamples(previous.current, current)
        previous.current = current
        setSample(current)
        if (current.disks) setDisks(current.disks)
        setPoints((list) => [...list.slice(-(LIVE_KEEP - 1)), point])
        setError(null)
      } catch (err) {
        if (stopped) return
        setError((err as Error).message)
      }
      // La siguiente lectura cuenta desde que empezó esta: un servidor lento no las amontona.
      if (!stopped) timer = setTimeout(() => void tick(), Math.max(1000, LIVE_EVERY - (Date.now() - started)))
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [call])

  return { points, sample, disks, error }
}

export function PerformanceView({ server }: { server: ServerSummary }) {
  const call = useModuleCall(server)
  const storageKey = `perf-range:${server.id}`
  // Sin preferencia guardada se intenta el histórico de 24 h; si no hay sysstat, se pasa a directo.
  const [range, setRangeState] = useState<Range>(() => readStoredRange(storageKey) ?? 24)
  const chosen = useRef(readStoredRange(storageKey) !== null)
  const [hover, setHover] = useState<number | null>(null)
  const [history, setHistory] = useState<{ hours: PerfHours; data: PerfHistory; at: number } | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [setup, setSetup] = useState<'confirm' | 'running' | null>(null)
  const [setupMessage, setSetupMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const live = useLiveSamples(call)

  const setRange = (next: Range) => {
    chosen.current = true
    storeRange(storageKey, next)
    setRangeState(next)
    setHover(null)
  }

  // Histórico del periodo elegido. En directo se consulta el de 6 h solo para saber si hay sysstat.
  const historyHours: PerfHours = range === 'live' ? 6 : range
  useEffect(() => {
    let cancelled = false
    setHistoryLoading(true)
    call('performance.history', { hours: historyHours }).then(
      (data) => {
        if (cancelled) return
        setHistory({ hours: historyHours, data, at: Date.now() })
        setHistoryError(null)
        setHistoryLoading(false)
        if (data.status !== 'ok' && !chosen.current) setRangeState('live')
      },
      (err: Error) => {
        if (cancelled) return
        setHistoryError(err.message)
        setHistoryLoading(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [call, historyHours, reloadKey])

  const runSetup = async () => {
    setSetup('running')
    setSetupMessage(null)
    try {
      const report = await call('performance.setup', {})
      setSetupMessage({ kind: 'ok', text: report.text.split('\n').filter(Boolean).slice(-1)[0] ?? 'sysstat activado.' })
      setReloadKey((k) => k + 1)
    } catch (err) {
      setSetupMessage({ kind: 'error', text: (err as Error).message })
    } finally {
      setSetup(null)
    }
  }

  // Lo que se dibuja: las lecturas en directo o el histórico del periodo.
  const isLive = range === 'live'
  const shownHistory = !isLive && history?.hours === range ? history : null
  const points = isLive ? live.points : (shownHistory?.data.points ?? [])
  const interval = shownHistory?.data.interval ?? 600
  const gap = isLive ? LIVE_EVERY * 4 : interval * 1000 * 2.5
  const domain = useMemo<[number, number]>(() => {
    if (isLive) {
      const last = points[points.length - 1]?.t ?? Date.now()
      const first = points[0]?.t ?? last
      return [Math.min(first, last - 5 * 60_000), last]
    }
    const end = shownHistory?.at ?? Date.now()
    return [end - (range as number) * 3_600_000, end]
  }, [isLive, points, shownHistory, range])
  const times = useMemo(() => points.map((p) => p.t), [points])
  const timeFormat = isLive ? (t: number) => clockLabel(t, true) : (t: number) => `${dayLabel(t)} ${clockLabel(t)}`

  const pick = useCallback(
    (defs: [PerfMetric, string, string, boolean?][]): ChartSeries[] =>
      defs.map(([key, label, color, area]) => ({ key, label, color, area, values: points.map((p) => p[key]) })),
    [points]
  )
  const cpuSeries = useMemo(() => pick([['cpu', 'CPU', BLUE, true], ['iowait', 'Esperando a disco', ORANGE]]), [pick])
  const loadSeries = useMemo(() => pick([['load1', '1 min', BLUE], ['load5', '5 min', ORANGE], ['load15', '15 min', AQUA]]), [pick])
  const memSeries = useMemo(
    () => pick(live.sample && live.sample.swapTotal > 0 ? [['mem', 'Memoria', BLUE, true], ['swap', 'Swap', ORANGE]] : [['mem', 'Memoria', BLUE, true]]),
    [pick, live.sample]
  )
  const netSeries = useMemo(() => pick([['netRx', 'Recibido', BLUE], ['netTx', 'Enviado', ORANGE]]), [pick])
  const diskSeries = useMemo(() => pick([['diskRead', 'Lectura', BLUE], ['diskWrite', 'Escritura', ORANGE]]), [pick])

  const cpus = live.sample?.cpus ?? null
  const loadReference = useMemo(() => (cpus ? { value: cpus, label: `${cpus} ${cpus === 1 ? 'núcleo' : 'núcleos'}` } : undefined), [cpus])
  const peak = (metric: PerfMetric, format: (v: number) => string) => {
    if (isLive || !points.length) return null
    const s = summarize(points, metric)
    return s.max === null ? null : (
      <span className="note">
        media {format(s.avg ?? 0)} · máx. {format(s.max)}
        {s.maxAt ? ` (${dayLabel(s.maxAt)} ${clockLabel(s.maxAt)})` : ''}
      </span>
    )
  }

  const common = { times, domain, gap, timeFormat, hover, onHover: setHover, stale: !isLive && historyLoading }
  const status = history?.data.status
  const collecting = history?.data.collecting

  return (
    <div className="module-view">
      <div className="module-header">
        <Icon name="chart" />
        <strong>Rendimiento</strong>
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="Periodo">
          {RANGES.map(([value, label]) => (
            <button key={value} className={range === value ? 'on' : ''} onClick={() => setRange(value)}>
              {label}
            </button>
          ))}
        </div>
        <button className="icon" title="Actualizar el histórico" disabled={isLive} onClick={() => setReloadKey((k) => k + 1)}>
          <Icon name="refresh" />
        </button>
      </div>
      <div className="module-body">
        {live.error && <div className="notice error">{live.error}</div>}
        {setupMessage && <div className={`notice ${setupMessage.kind}`}>{setupMessage.text}</div>}
        {historyError && !isLive && <div className="notice error">{historyError}</div>}
        {status === 'missing' && (
          <div className="notice warn notice-row">
            <span>
              Para ver días atrás hace falta <strong>sysstat</strong> en el servidor: guarda una muestra cada 10 minutos (ocupa unos pocos MB al
              mes). Mientras tanto, las gráficas se dibujan en directo desde que abriste esta pestaña.
            </span>
            <button disabled={setup === 'running'} onClick={() => setSetup('confirm')}>
              {setup === 'running' ? 'Instalando…' : 'Instalar sysstat'}
            </button>
          </div>
        )}
        {status === 'nodata' && collecting === false && (
          <div className="notice warn notice-row">
            <span>sysstat está instalado pero la recogida de datos está desactivada, así que no hay histórico.</span>
            <button disabled={setup === 'running'} onClick={() => setSetup('confirm')}>
              {setup === 'running' ? 'Activando…' : 'Activar la recogida'}
            </button>
          </div>
        )}
        {status === 'nodata' && collecting !== false && !isLive && (
          <div className="notice warn">
            sysstat todavía no tiene datos de este periodo. Si se acaba de activar, la primera muestra llega a los 10 minutos.
          </div>
        )}
        {history?.data.warning && !isLive && <div className="notice warn mono">{history.data.warning}</div>}

        <Tiles sample={live.sample} point={live.points[live.points.length - 1] ?? null} />

        <div className="chart-caption note">
          {isLive
            ? `En directo: una lectura cada ${LIVE_EVERY / 1000} s mientras esta pestaña esté abierta (se guarda la última hora).`
            : shownHistory
              ? `Histórico de sysstat: ${shownHistory.data.points.length} muestras, una cada ${Math.round(interval / 60)} min. Las horas son las de este equipo.`
              : 'Cargando el histórico…'}
        </div>

        <div className="chart-grid-layout">
          <TimeChart title="CPU" series={cpuSeries} format={fmtPct} axisFormat={fmtAxisPct} fixedMax={100} extra={peak('cpu', fmtPct)} {...common} />
          <TimeChart title="Carga (1 / 5 / 15 min)" series={loadSeries} format={fmtLoad} minMax={1} reference={loadReference} extra={peak('load1', fmtLoad)} {...common} />
          <TimeChart title="Memoria" series={memSeries} format={fmtPct} axisFormat={fmtAxisPct} fixedMax={100} extra={peak('mem', fmtPct)} {...common} />
          <TimeChart title="Red" series={netSeries} format={formatRate} axisFormat={fmtAxisRate} binary minMax={1024} extra={peak('netRx', formatRate)} {...common} />
          <TimeChart title="Disco (E/S)" series={diskSeries} format={formatRate} axisFormat={fmtAxisRate} binary minMax={1024} extra={peak('diskWrite', formatRate)} {...common} />
        </div>

        <DiskUsageList disks={live.disks} />
      </div>
      {setup === 'confirm' && (
        <ConfirmDialog
          title={status === 'missing' ? 'Instalar sysstat' : 'Activar sysstat'}
          confirmLabel={status === 'missing' ? 'Instalar' : 'Activar'}
          onCancel={() => setSetup(null)}
          onConfirm={() => void runSetup()}
        >
          Se instalará el paquete sysstat con el gestor de paquetes del servidor (apt, dnf, yum, zypper o pacman) y se activará su recogida de
          datos, que guarda una muestra cada 10 minutos en /var/log/sysstat o /var/log/sa. Necesita sudo.
        </ConfirmDialog>
      )}
    </div>
  )
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'error' }) {
  return (
    <div className={`stat-card ${tone ?? ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">
        {label}
        {sub && <span className="stat-sub"> · {sub}</span>}
      </div>
    </div>
  )
}

/** Valores de ahora mismo (última lectura en directo). */
function Tiles({ sample, point }: { sample: PerfSample | null; point: PerfPoint | null }) {
  if (!sample) return <div className="empty-note">Leyendo el servidor…</div>
  const memUsed = sample.memTotal - sample.memAvailable
  const memPct = sample.memTotal ? (memUsed / sample.memTotal) * 100 : 0
  const swapUsed = sample.swapTotal - sample.swapFree
  const load = sample.load
  const loadTone = load && load[0] > sample.cpus * 2 ? 'error' : load && load[0] > sample.cpus ? 'warn' : undefined
  const pctTone = (pct: number | null | undefined) => (pct === null || pct === undefined ? undefined : pct >= 95 ? 'error' : pct >= 85 ? 'warn' : undefined)
  return (
    <div className="stat-grid">
      <Tile label="CPU" sub={`${sample.cpus} ${sample.cpus === 1 ? 'núcleo' : 'núcleos'}`} value={point?.cpu != null ? fmtPct(point.cpu) : '…'} tone={pctTone(point?.cpu)} />
      <Tile label="Carga (1 min)" sub={load ? `5 min ${fmtLoad(load[1])} · 15 min ${fmtLoad(load[2])}` : undefined} value={load ? fmtLoad(load[0]) : '—'} tone={loadTone} />
      <Tile label="Memoria en uso" sub={`${formatSize(memUsed)} de ${formatSize(sample.memTotal)}`} value={fmtPct(memPct)} tone={pctTone(memPct)} />
      <Tile
        label="Swap en uso"
        sub={sample.swapTotal ? `de ${formatSize(sample.swapTotal)}` : undefined}
        value={sample.swapTotal ? formatSize(swapUsed) : 'sin swap'}
        tone={sample.swapTotal ? pctTone((swapUsed / sample.swapTotal) * 100) : undefined}
      />
      <Tile label="Red" sub={point?.netTx != null ? `enviando ${formatRate(point.netTx)}` : undefined} value={point?.netRx != null ? `↓ ${formatRate(point.netRx)}` : '…'} />
      <Tile label="Disco" sub={point?.diskWrite != null ? `escribiendo ${formatRate(point.diskWrite)}` : undefined} value={point?.diskRead != null ? `R ${formatRate(point.diskRead)}` : '…'} />
      <Tile label="Encendido desde hace" value={fmtUptime(sample.uptime)} />
    </div>
  )
}

function DiskUsageList({ disks }: { disks: PerfSample['disks'] }) {
  if (!disks) return null
  return (
    <div className="disk-usage">
      <div className="section-label">Espacio en disco</div>
      {!disks.length && <div className="empty-note">df no devolvió ningún sistema de ficheros.</div>}
      {disks.map((d) => {
        // Como df: lo usado sobre lo que el usuario puede llegar a usar (sin la reserva de root).
        const pct = d.used + d.available > 0 ? (d.used / (d.used + d.available)) * 100 : 0
        const tone = pct >= 95 ? 'error' : pct >= 85 ? 'warn' : ''
        return (
          <div key={d.filesystem + d.mount} className="disk-row" title={`${d.filesystem} (${d.type})`}>
            <span className="mono disk-mount">{d.mount}</span>
            <div className={`disk-bar ${tone}`}>
              <div style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <span className="disk-figures">
              <strong>{fmtNumber(pct, 0)} %</strong> · {formatSize(d.used)} de {formatSize(d.size)} · libres {formatSize(d.available)}
            </span>
            <span className="note">{d.type}</span>
          </div>
        )
      })}
    </div>
  )
}
