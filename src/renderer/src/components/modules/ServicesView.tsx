import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ServiceUnit } from '@shared/modules'
import type { ServerSummary } from '@shared/types'
import { useModuleCall } from '../../lib/sudo'
import { Icon } from '../Icon'
import { ServicePanel, stateClass } from './ServicePanel'

interface Props {
  server: ServerSummary
  onOpenFile: (path: string) => void
}

type Show = 'active' | 'all' | 'failed'

/** Lista de servicios de systemd y el detalle del elegido. */
export function ServicesView({ server, onOpenFile }: Props) {
  const call = useModuleCall(server)
  const [units, setUnits] = useState<ServiceUnit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [show, setShow] = useState<Show>('active')
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setUnits(await call('services.list', {}))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [call])

  useEffect(() => {
    void load()
  }, [load])

  const failed = units.filter((u) => u.active === 'failed').length
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return units.filter((u) => {
      if (show === 'active' && u.active === 'inactive') return false
      if (show === 'failed' && u.active !== 'failed') return false
      return !needle || u.name.toLowerCase().includes(needle) || u.description.toLowerCase().includes(needle)
    })
  }, [units, filter, show])

  return (
    <div className="module-split">
      <div className="module-list">
        <div className="toolbar">
          <input placeholder="Buscar servicio…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="icon" title="Actualizar" disabled={loading} onClick={() => void load()}>
            <Icon name="refresh" />
          </button>
        </div>
        <div className="segmented" style={{ margin: '6px 8px' }}>
          <button className={show === 'active' ? 'active' : ''} onClick={() => setShow('active')}>
            En marcha
          </button>
          <button className={show === 'failed' ? 'active' : ''} onClick={() => setShow('failed')}>
            Fallidos{failed ? ` (${failed})` : ''}
          </button>
          <button className={show === 'all' ? 'active' : ''} onClick={() => setShow('all')}>
            Todos
          </button>
        </div>
        {error && <div className="notice error" style={{ margin: 8 }}>{error}</div>}
        <div className="unit-list">
          {loading && !units.length && <div className="empty-note">Cargando…</div>}
          {!loading && !visible.length && !error && <div className="empty-note">No hay servicios que coincidan.</div>}
          {visible.map((u) => (
            <div key={u.name} className={`unit-row ${selected === u.name ? 'selected' : ''}`} onClick={() => setSelected(u.name)} title={u.description}>
              <span className={`state-dot-sm ${stateClass(u.active)}`} />
              <span className="unit-name">{u.name.replace(/\.service$/, '')}</span>
              <span className="unit-sub">{u.active === 'active' ? u.sub : u.active}</span>
              {u.enabled === 'enabled' && <span className="badge" title="Arranca con el sistema">auto</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="module-detail">
        {selected ? (
          <ServicePanel
            key={selected}
            server={server}
            unit={selected}
            onOpenFile={onOpenFile}
            onChanged={(d) =>
              setUnits((list) => list.map((u) => (u.name === selected ? { ...u, active: d.active, sub: d.sub, enabled: d.enabled || u.enabled } : u)))
            }
          />
        ) : (
          <div className="welcome">Elige un servicio para ver su estado y su registro.</div>
        )}
      </div>
    </div>
  )
}
