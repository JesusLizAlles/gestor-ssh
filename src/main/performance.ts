import { z } from 'zod'
import type { CommandReport, ModuleCalls } from '@shared/modules'
import { splitSections } from '@shared/modules'
import { parseSadf, parseSample, type PerfHistory } from '@shared/performance'
import { outputText, runScript, type RunResult } from './ssh/commands'
import type { ServerSession } from './ssh/sessions'

type PerformanceCall = Extract<keyof ModuleCalls, `performance.${string}`>

const text = (r: RunResult) => r.stdout.toString('utf8')

export const performanceSchemas: { [K in PerformanceCall]: z.ZodType<ModuleCalls[K]['args']> } = {
  'performance.sample': z.object({ disks: z.boolean() }).strict(),
  'performance.history': z.object({ hours: z.union([z.literal(6), z.literal(24), z.literal(168), z.literal(720)]) }).strict(),
  'performance.setup': z.object({}).strict()
}

function sampleScript(disks: boolean): string {
  return `
[ -r /proc/stat ] || { echo "No hay /proc/stat: este módulo necesita Linux" >&2; exit 3; }
echo @@stat; head -n 1 /proc/stat
echo @@cpus; grep -c '^cpu[0-9]' /proc/stat
echo @@uptime; cat /proc/uptime
echo @@load; cat /proc/loadavg
echo @@mem; grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
echo @@net; cat /proc/net/dev 2>/dev/null
echo @@disk; cat /proc/diskstats 2>/dev/null
${
  disks
    ? `echo @@df
# Un montaje de red colgado bloquearía df: se corta a los 5 segundos.
if command -v timeout >/dev/null 2>&1; then timeout 5 df -P -k -T 2>/dev/null; else df -P -k -T 2>/dev/null; fi`
    : ''
}
true
`
}

/**
 * Datos de sysstat de los últimos días. Los ficheros se llaman saDD (día del mes) o saYYYYMMDD según la
 * configuración; se lee cada uno una sola vez y el periodo exacto se filtra luego por la hora de cada fila.
 */
function historyScript(hours: number): string {
  const days = Math.ceil(hours / 24)
  return `
if ! command -v sadf >/dev/null 2>&1; then echo @@missing; exit 0; fi
echo @@collecting
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active sysstat-collect.timer 2>/dev/null
  systemctl is-active sysstat 2>/dev/null
fi
[ -f /etc/default/sysstat ] && grep -E '^ENABLED=' /etc/default/sysstat
echo @@data
dir=
for d in /var/log/sysstat /var/log/sa; do if [ -d "$d" ]; then dir=$d; break; fi; done
[ -n "$dir" ] || exit 0
now=$(date +%s)
seen=' '
i=${days}
while [ $i -ge 0 ]; do
  ts=$((now - i * 86400))
  ymd=$(date -d "@$ts" +%Y%m%d 2>/dev/null)
  dd=$(date -d "@$ts" +%d 2>/dev/null)
  if [ -n "$dd" ]; then
    for f in "$dir/sa$ymd" "$dir/sa$dd"; do
      [ -f "$f" ] || continue
      real=$(readlink -f "$f" 2>/dev/null || printf %s "$f")
      case "$seen" in *" $real "*) ;; *) seen="$seen$real "; sadf -d "$f" -- -u -q -r -S -n DEV -b ;; esac
      break
    done
  fi
  i=$((i - 1))
done
true
`
}

/** Instala sysstat y activa la recogida de datos (una muestra cada 10 minutos). */
const SETUP_SCRIPT = `
set -e
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y sysstat || { apt-get update && apt-get install -y sysstat; }
  # En Debian y Ubuntu la recogida viene desactivada.
  if [ -f /etc/default/sysstat ]; then sed -i 's/^ENABLED=.*/ENABLED="true"/' /etc/default/sysstat; fi
elif command -v dnf >/dev/null 2>&1; then dnf install -y sysstat
elif command -v yum >/dev/null 2>&1; then yum install -y sysstat
elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install sysstat
elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed sysstat
else echo "No se reconoce el gestor de paquetes del servidor: instala sysstat a mano." >&2; exit 2
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now sysstat >/dev/null 2>&1 || true
  systemctl enable --now sysstat-collect.timer >/dev/null 2>&1 || true
  systemctl enable --now sysstat-summary.timer >/dev/null 2>&1 || true
  systemctl restart sysstat >/dev/null 2>&1 || true
fi
echo "sysstat instalado y activado: guardará una muestra cada 10 minutos."
`

/** ¿Está activa la recogida? Por lo que dicen systemd y /etc/default/sysstat (null si no se sabe). */
export function parseCollecting(text: string): boolean | null {
  if (/^ENABLED="?false"?/m.test(text)) return false
  if (/^active$/m.test(text)) return true
  if (/^(inactive|failed)$/m.test(text)) return false
  return null
}

type Handlers = { [K in PerformanceCall]: (session: ServerSession, args: ModuleCalls[K]['args']) => Promise<ModuleCalls[K]['result']> }

export const performanceHandlers: Handlers = {
  'performance.sample': async (session, { disks }) => {
    const result = await runScript(session, sampleScript(disks), { timeoutMs: 20_000 })
    if (result.code !== 0) throw new Error(outputText(result) || 'No se pudieron leer los datos de rendimiento')
    return parseSample(splitSections(text(result)), Date.now())
  },

  'performance.history': async (session, { hours }): Promise<PerfHistory> => {
    const result = await runScript(session, historyScript(hours), { timeoutMs: 120_000, maxBytes: 48 * 1024 * 1024 })
    const output = text(result)
    if (output.startsWith('@@missing')) return { status: 'missing', points: [], interval: null, collecting: null, warning: null }
    const sections = splitSections(output)
    const now = Date.now()
    const { points, interval } = parseSadf(sections.get('data') ?? '')
    const inPeriod = points.filter((p) => p.t >= now - hours * 3_600_000)
    const latest = points[points.length - 1]?.t ?? 0
    // Si hay datos recientes, está recogiendo diga lo que diga systemd (puede ir por cron).
    const collecting = latest > now - 30 * 60_000 ? true : parseCollecting(sections.get('collecting') ?? '')
    const stderr = result.stderr.trim()
    return {
      status: inPeriod.length ? 'ok' : 'nodata',
      points: inPeriod,
      interval,
      collecting,
      warning: stderr ? stderr.split('\n').slice(-3).join('\n') : null
    }
  },

  'performance.setup': async (session): Promise<CommandReport> => {
    const result = await runScript(session, SETUP_SCRIPT, { sudo: true, timeoutMs: 300_000 })
    const output = outputText(result)
    if (result.code !== 0) throw new Error(output.split('\n').slice(-8).join('\n') || `No se pudo instalar sysstat (código ${result.code})`)
    return { ok: true, text: output }
  }
}
