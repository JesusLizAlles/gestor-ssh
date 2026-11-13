import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { nearestIndex, xTicks, yTicks } from '@shared/chart-scale'

// Gráfica de líneas en el tiempo (SVG), con cruceta y ventana de valores al pasar el ratón.
// Todas las gráficas de una vista comparten la hora señalada: al mover el ratón por una, se marca en todas.

/** Paleta categórica para fondo oscuro, en orden fijo (azul, naranja, aguamarina). */
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70'] as const

export interface ChartSeries {
  key: string
  label: string
  color: string
  values: (number | null)[]
  /** Relleno bajo la línea (solo para la serie principal). */
  area?: boolean
}

interface Props {
  title: string
  times: number[]
  series: ChartSeries[]
  /** Intervalo de tiempo que se dibuja (ms). */
  domain: [number, number]
  /** Valor en la ventana del ratón y en la leyenda. */
  format: (value: number) => string
  /** Etiquetas del eje Y (más cortas); por defecto, `format`. */
  axisFormat?: (value: number) => string
  /** Máximo fijo del eje Y (100 para porcentajes). */
  fixedMax?: number
  /** Máximo mínimo del eje Y, para que una serie plana no parezca un pico. */
  minMax?: number
  /** Escala en potencias de 1024 (bytes). */
  binary?: boolean
  /** Línea horizontal de referencia (p. ej., número de núcleos en la carga). */
  reference?: { value: number; label: string }
  /** Más de este tiempo entre dos puntos = hueco (la línea se corta). */
  gap: number
  /** Formato de la hora en la ventana del ratón. */
  timeFormat: (t: number) => string
  hover: number | null
  onHover: (t: number | null) => void
  /** Algo a la derecha del título (máximos, notas…). */
  extra?: ReactNode
  /** Datos recargándose: se mantiene lo anterior, atenuado. */
  stale?: boolean
}

const HEIGHT = 170
const M = { top: 10, right: 14, bottom: 22, left: 58 }

/** Tramos continuos de una serie: se corta donde no hay valor o hay un hueco de tiempo. */
function segments(times: number[], values: (number | null)[], gap: number): [number, number][][] {
  const out: [number, number][][] = []
  let current: [number, number][] = []
  for (let i = 0; i < times.length; i++) {
    const v = values[i]
    if (v === null || v === undefined || (i > 0 && times[i]! - times[i - 1]! > gap)) {
      if (current.length) out.push(current)
      current = []
    }
    if (v !== null && v !== undefined) current.push([times[i]!, v])
  }
  if (current.length) out.push(current)
  return out
}

export function TimeChart(props: Props) {
  const { title, times, series, domain, format, fixedMax, minMax, binary = false, reference, gap, hover, onHover } = props
  const axisFormat = props.axisFormat ?? format
  const wrapRef = useRef<HTMLDivElement>(null)
  const clipId = `clip${useId().replace(/\W/g, '')}`
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const plotW = Math.max(0, width - M.left - M.right)
  const plotH = HEIGHT - M.top - M.bottom

  const geometry = useMemo(() => {
    let max = minMax ?? 0
    for (const s of series) for (const v of s.values) if (v !== null && v > max) max = v
    if (reference && reference.value > max) max = reference.value
    const { top, ticks } = fixedMax ? yTicks(fixedMax, false, true) : yTicks(max || 1, binary, false)
    const span = domain[1] - domain[0] || 1
    const x = (t: number) => M.left + ((t - domain[0]) / span) * plotW
    const y = (v: number) => M.top + plotH - (Math.min(v, top) / top) * plotH
    const paths = series.map((s) => {
      const segs = segments(times, s.values, gap)
      const line = segs.map((seg) => seg.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')).join('')
      const area = s.area
        ? segs
            .filter((seg) => seg.length > 1)
            .map((seg) => {
              const base = (M.top + plotH).toFixed(1)
              return `M${x(seg[0]![0]).toFixed(1)},${base}${seg.map(([t, v]) => `L${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')}L${x(seg[seg.length - 1]![0]).toFixed(1)},${base}Z`
            })
            .join('')
        : ''
      // Un punto suelto (rodeado de huecos) no se vería como línea: se dibuja como punto.
      const dots = segs.filter((seg) => seg.length === 1).map((seg) => [x(seg[0]![0]), y(seg[0]![1])] as const)
      return { line, area, dots }
    })
    return { top, ticks, x, y, paths }
  }, [series, times, domain, gap, fixedMax, minMax, binary, reference, plotW, plotH])

  const ticksX = useMemo(() => xTicks(domain, plotW), [domain, plotW])

  // Punto señalado: el más cercano a la hora del ratón, si está dentro del intervalo y no en un hueco.
  const index = hover === null ? -1 : nearestIndex(times, hover)
  const hoverT = index >= 0 ? times[index]! : null
  const showHover = hoverT !== null && hover !== null && Math.abs(hoverT - hover) <= gap && hoverT >= domain[0] && hoverT <= domain[1]

  const last = (values: (number | null)[]) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i]!
    return null
  }

  const pointer = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left - M.left
    if (px < 0 || px > plotW) return onHover(null)
    onHover(domain[0] + (px / plotW) * (domain[1] - domain[0]))
  }

  const hx = showHover ? geometry.x(hoverT!) : 0
  // A la derecha de la cruceta; si no cabe, a la izquierda (se ancla por su borde derecho).
  const tooltipStyle = hx + 14 + 190 > width ? { right: width - hx + 14 } : { left: hx + 14 }

  return (
    <div className={`chart-card ${props.stale ? 'stale' : ''}`}>
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        {series.length > 1 && (
          <div className="chart-legend">
            {series.map((s) => {
              const v = last(s.values)
              return (
                <span key={s.key} className="legend-item">
                  <span className="legend-key" style={{ background: s.color }} />
                  {s.label}
                  {v !== null && <span className="legend-value">{format(v)}</span>}
                </span>
              )
            })}
          </div>
        )}
        <div className="spacer" />
        {props.extra}
      </div>
      <div className="chart-plot" ref={wrapRef}>
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={title}
            onPointerMove={(e) => pointer(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => onHover(null)}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={M.left} y={M.top - 2} width={plotW} height={plotH + 4} />
              </clipPath>
            </defs>
            {geometry.ticks.map((v) => (
              <g key={v}>
                <line className="chart-grid" x1={M.left} x2={M.left + plotW} y1={geometry.y(v)} y2={geometry.y(v)} />
                <text className="chart-axis" x={M.left - 8} y={geometry.y(v)} textAnchor="end" dominantBaseline="middle">
                  {axisFormat(v)}
                </text>
              </g>
            ))}
            {ticksX.map(({ t, label }) => (
              <g key={t}>
                <line className="chart-grid vertical" x1={geometry.x(t)} x2={geometry.x(t)} y1={M.top} y2={M.top + plotH} />
                <text className="chart-axis" x={geometry.x(t)} y={HEIGHT - 6} textAnchor="middle">
                  {label}
                </text>
              </g>
            ))}
            {reference && (
              <g>
                <line className="chart-reference" x1={M.left} x2={M.left + plotW} y1={geometry.y(reference.value)} y2={geometry.y(reference.value)} />
                {/* Encima de la línea, o debajo si está pegada al borde superior. */}
                <text
                  className="chart-axis"
                  x={M.left + plotW - 4}
                  y={geometry.y(reference.value) - M.top < 12 ? geometry.y(reference.value) + 12 : geometry.y(reference.value) - 5}
                  textAnchor="end"
                >
                  {reference.label}
                </text>
              </g>
            )}
            <g clipPath={`url(#${clipId})`}>
              {geometry.paths.map((p, i) => (
                <g key={series[i]!.key}>
                  {p.area && <path d={p.area} fill={series[i]!.color} fillOpacity={0.14} stroke="none" />}
                  <path d={p.line} fill="none" stroke={series[i]!.color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
                  {p.dots.map(([cx, cy]) => (
                    <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={2} fill={series[i]!.color} />
                  ))}
                </g>
              ))}
            </g>
            {showHover && (
              <g pointerEvents="none">
                <line className="chart-crosshair" x1={hx} x2={hx} y1={M.top} y2={M.top + plotH} />
                {series.map((s) => {
                  const v = s.values[index]
                  return v === null || v === undefined ? null : <circle key={s.key} className="chart-dot" cx={hx} cy={geometry.y(v)} r={4} fill={s.color} />
                })}
              </g>
            )}
          </svg>
        )}
        {showHover && (
          <div className="chart-tooltip" style={tooltipStyle}>
            <div className="chart-tooltip-time">{props.timeFormat(hoverT!)}</div>
            {series.map((s) => {
              const v = s.values[index]
              return (
                <div key={s.key} className="chart-tooltip-row">
                  <span className="legend-key" style={{ background: s.color }} />
                  {v === null || v === undefined ? <span className="note">sin dato</span> : <strong>{format(v)}</strong>}
                  <span className="note">{s.label}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
