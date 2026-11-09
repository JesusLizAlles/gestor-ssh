import { useCallback, useEffect, useState } from 'react'
import { formatSize } from '@shared/format'
import type { LogResult, ServiceAction, ServiceDetail } from '@shared/modules'
import type { ServerSummary } from '@shared/types'
import { useModuleCall } from '../../lib/sudo'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'

interface Props {
  server: ServerSummary
  unit: string
  onOpenFile: (path: string) => void
  /** Tras una acción (para refrescar la lista de servicios). */
  onChanged?: (detail: ServiceDetail) => void
}

const ACTION_LABELS: Record<ServiceAction, string> = {
  start: 'Arrancar',
  stop: 'Parar',
  restart: 'Reiniciar',
  reload: 'Recargar',
  enable: 'Habilitar',
  disable: 'Deshabilitar'
}

/** Acciones que cortan el servicio: se confirman siempre. En producción se confirma todo. */
const DISRUPTIVE = new Set<ServiceAction>(['stop', 'restart', 'disable'])

export function stateClass(active: string): string {
  if (active === 'active') return 'ok'
  if (active === 'failed') return 'error'
  if (active === 'activating' || active === 'deactivating' || active === 'reloading') return 'warn'
  return ''
}

/** Estado de un servicio de systemd, con sus acciones y el final de su registro. */
export function ServicePanel({ server, unit, onOpenFile, onChanged }: Props) {
  const call = useModuleCall(server)
  const [detail, setDetail] = useState<ServiceDetail | null>(null)
  const [busy, setBusy] = useState<ServiceAction | 'load' | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ServiceAction | null>(null)

  const load = useCallback(async () => {
    setBusy('load')
    setError(null)
    try {
      setDetail(await call('services.show', { unit }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }, [call, unit])

  useEffect(() => {
    setDetail(null)
    void load()
  }, [load])

  const run = async (action: ServiceAction) => {
    setConfirm(null)
    setBusy(action)
    setError(null)
    try {
      const updated = await call('services.action', { unit, action })
      setDetail(updated)
      onChanged?.(updated)
    } catch (err) {
      setError((err as Error).message)
      void call('services.show', { unit }).then(setDetail, () => {})
    } finally {
      setBusy(null)
    }
  }

  const request = (action: ServiceAction) => {
    if (DISRUPTIVE.has(action) || server.environment === 'prod') setConfirm(action)
    else void run(action)
  }

  const active = detail?.active === 'active'
  const enabled = detail?.enabled === 'enabled'
  const canToggle = detail && ['enabled', 'disabled'].includes(detail.enabled)

  return (
    <div className="service-panel">
      <div className="service-head">
        <span className={`state-pill ${stateClass(detail?.active ?? '')}`}>{detail ? `${detail.active}${detail.sub ? ` · ${detail.sub}` : ''}` : '…'}</span>
        <strong className="service-name">{unit}</strong>
        <span className="note">{detail?.description}</span>
        <div className="spacer" />
        <button className="icon" title="Actualizar" disabled={!!busy} onClick={() => void load()}>
          <Icon name="refresh" />
        </button>
      </div>
      {detail && (
        <div className="service-meta">
          <span>
            Arranque automático: <b>{detail.enabled || '—'}</b>
          </span>
          {detail.since && <span>Desde: {detail.since}</span>}
          {detail.mainPid && <span>PID {detail.mainPid}</span>}
          {detail.memory && <span>Memoria {formatSize(detail.memory)}</span>}
          {detail.fragmentPath && (
            <button className="link" title="Abrir el fichero de la unidad en el editor" onClick={() => onOpenFile(detail.fragmentPath)}>
              {detail.fragmentPath}
            </button>
          )}
        </div>
      )}
      <div className="service-actions">
        {(['start', 'stop', 'restart', 'reload'] as ServiceAction[]).map((action) => (
          <button
            key={action}
            disabled={!!busy || !detail || (action === 'start' && active) || (action !== 'start' && action !== 'restart' && !active)}
            className={action === 'stop' ? 'danger' : ''}
            onClick={() => request(action)}
          >
            {busy === action ? `${ACTION_LABELS[action]}…` : ACTION_LABELS[action]}
          </button>
        ))}
        {canToggle && (
          <button disabled={!!busy} onClick={() => request(enabled ? 'disable' : 'enable')}>
            {busy === 'enable' || busy === 'disable' ? '…' : enabled ? 'Deshabilitar al inicio' : 'Habilitar al inicio'}
          </button>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      <JournalBox server={server} unit={unit} refreshKey={detail} />
      {confirm && (
        <ConfirmDialog
          title={`${ACTION_LABELS[confirm]} ${unit}`}
          confirmLabel={ACTION_LABELS[confirm]}
          danger={DISRUPTIVE.has(confirm)}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(confirm)}
        >
          {server.environment === 'prod' && <div className="notice error">Servidor de producción: {server.name}.</div>}
          {confirm === 'stop' && 'El servicio dejará de dar servicio hasta que se vuelva a arrancar.'}
          {confirm === 'restart' && 'El servicio se parará y volverá a arrancar: las conexiones en curso se cortan.'}
          {confirm === 'disable' && 'El servicio no arrancará solo al reiniciar el servidor.'}
          {!DISRUPTIVE.has(confirm) && `Se ejecutará «systemctl ${confirm} ${unit}».`}
        </ConfirmDialog>
      )}
    </div>
  )
}

/** Final del registro de systemd de una unidad. */
function JournalBox({ server, unit, refreshKey }: { server: ServerSummary; unit: string; refreshKey: unknown }) {
  const call = useModuleCall(server)
  const [sudo, setSudo] = useState(false)
  const [lines, setLines] = useState(200)
  const [result, setResult] = useState<LogResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setResult(await call('services.logs', { unit, lines, sudo }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [call, unit, lines, sudo])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  return (
    <LogBox
      title="Registro (journalctl)"
      text={result?.text ?? ''}
      error={error}
      loading={loading}
      onRefresh={() => void load()}
      lines={lines}
      onLines={setLines}
      extra={
        result?.limited && !sudo ? (
          <span className="note">
            Solo se ve parte del registro.{' '}
            <button className="link" onClick={() => setSudo(true)}>
              Ver completo con sudo
            </button>
          </span>
        ) : null
      }
    />
  )
}

interface LogBoxProps {
  title: string
  text: string
  error: string | null
  loading: boolean
  onRefresh: () => void
  lines: number
  onLines: (lines: number) => void
  extra?: React.ReactNode
}

/** Caja de texto de registro: se coloca al final para ver lo último. */
export function LogBox({ title, text, error, loading, onRefresh, lines, onLines, extra }: LogBoxProps) {
  return (
    <div className="log-box">
      <div className="log-head">
        <span className="section-label">{title}</span>
        {extra}
        <div className="spacer" />
        <select value={lines} onChange={(e) => onLines(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Líneas">
          {[100, 200, 500, 2000].map((n) => (
            <option key={n} value={n}>
              Últimas {n}
            </option>
          ))}
        </select>
        <button className="icon" title="Actualizar" disabled={loading} onClick={onRefresh}>
          <Icon name="refresh" />
        </button>
      </div>
      {error ? (
        <div className="notice error">{error}</div>
      ) : (
        <pre
          className="log-text"
          ref={(el) => {
            if (el) el.scrollTop = el.scrollHeight
          }}
        >
          {loading && !text ? 'Cargando…' : text || '(vacío)'}
        </pre>
      )}
    </div>
  )
}
