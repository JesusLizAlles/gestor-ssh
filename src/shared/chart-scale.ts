// Escalas de las gráficas de tiempo: divisiones del eje Y, marcas horarias del eje X y búsqueda del punto más cercano.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TIME_STEPS = [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY]

/** Paso «redondo» (1, 2, 2,5, 5 × 10ⁿ) para unas 4 divisiones. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const pow = 10 ** Math.floor(Math.log10(raw))
  const f = raw / pow
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow
}

export function yTicks(max: number, binary: boolean, fixed: boolean): { top: number; ticks: number[] } {
  if (fixed) return { top: max, ticks: [0, max / 4, max / 2, (3 * max) / 4, max] }
  // En bytes, divisiones redondas en KB/MB/GB (potencias de 1024), no en múltiplos de 1000.
  let unit = 1
  if (binary) while (max / unit >= 1024) unit *= 1024
  const step = niceStep(max / unit / 4) * unit
  const top = Math.max(step, Math.ceil(max / step - 1e-9) * step)
  const ticks: number[] = []
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(v)
  return { top, ticks }
}

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export const dayLabel = (t: number) => {
  const d = new Date(t)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
export const clockLabel = (t: number, seconds = false) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`
}

/** Marcas del eje X alineadas a horas «redondas» locales; a medianoche se escribe el día. */
export function xTicks(domain: [number, number], width: number): { t: number; label: string }[] {
  const span = domain[1] - domain[0]
  if (!(span > 0) || width <= 0) return []
  const target = Math.max(2, Math.floor(width / 90))
  const step = TIME_STEPS.find((s) => span / s <= target) ?? 7 * DAY
  const out: { t: number; label: string }[] = []
  let t = startOfDay(domain[0])
  if (step < DAY) {
    t += Math.ceil((domain[0] - t) / step) * step
    for (; t <= domain[1]; t += step) out.push({ t, label: startOfDay(t) === t ? dayLabel(t) : clockLabel(t) })
  } else {
    for (; t <= domain[1]; t = startOfDay(t + step + 2 * HOUR)) if (t >= domain[0]) out.push({ t, label: dayLabel(t) })
  }
  return out
}

/** Índice del punto más cercano a `t` (los tiempos van ordenados). */
export function nearestIndex(times: number[], t: number): number {
  if (!times.length) return -1
  let lo = 0
  let hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid]! < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(times[lo - 1]! - t) <= Math.abs(times[lo]! - t)) return lo - 1
  return lo
}
