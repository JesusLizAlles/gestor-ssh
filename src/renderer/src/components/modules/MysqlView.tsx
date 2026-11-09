import { useCallback, useEffect, useState } from 'react'
import { formatSize } from '@shared/format'
import type { MysqlQuery, TableResult } from '@shared/modules'
import type { ServerSummary } from '@shared/types'
import { useModuleCall } from '../../lib/sudo'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { FileLinks, FileLog, ResultTable, SubTabs, useLoad } from './common'
import { ServicePanel } from './ServicePanel'

interface Props {
  server: ServerSummary
  onOpenFile: (path: string) => void
}

type Tab = 'service' | MysqlQuery | 'config' | 'errors'

/** Preferencia «usar sudo» por servidor (es cómodo que se recuerde, no es un dato importante). */
function useStoredSudo(serverId: string): [boolean, (value: boolean) => void] {
  const key = `mysql-sudo:${serverId}`
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) !== '0'
    } catch {
      return true
    }
  })
  return [
    value,
    (next) => {
      setValue(next)
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // Sin almacenamiento: se queda solo en esta sesión.
      }
    }
  ]
}

export function MysqlView({ server, onOpenFile }: Props) {
  const call = useModuleCall(server)
  const overview = useLoad(useCallback(() => call('mysql.overview', {}), [call]))
  const [tab, setTab] = useState<Tab>('service')
  const [sudo, setSudo] = useStoredSudo(server.id)

  const data = overview.data
  if (overview.loading && !data) return <div className="welcome">Comprobando MySQL/MariaDB…</div>
  if (overview.error) return <div className="notice error" style={{ margin: 12 }}>{overview.error}</div>
  if (!data?.installed) return <div className="welcome">MySQL/MariaDB no está instalado en {server.name}.</div>

  return (
    <div className="module-view">
      <div className="module-header">
        <strong>MySQL / MariaDB</strong>
        <span className="note">{data.version}</span>
        <div className="spacer" />
        <label className="check note" title="Entrar como root por el socket con «sudo mysql». Sin sudo se usa ~/.my.cnf del usuario.">
          <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} /> Usar sudo
        </label>
        <button className="icon" title="Actualizar" onClick={overview.reload}>
          <Icon name="refresh" />
        </button>
      </div>
      <SubTabs
        tabs={[
          ['service', 'Servicio'],
          ['databases', 'Bases de datos'],
          ['status', 'Estado'],
          ['processlist', 'Procesos'],
          ['config', 'Configuración'],
          ['errors', 'Registro']
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="module-body">
        {tab === 'service' &&
          (data.service ? (
            <ServicePanel server={server} unit={data.service} onOpenFile={onOpenFile} />
          ) : (
            <div className="empty-note">No se encontró el servicio de systemd (mariadb, mysql o mysqld).</div>
          ))}
        {(tab === 'databases' || tab === 'status' || tab === 'processlist') && <QueryTab key={`${tab}-${sudo}`} server={server} query={tab} sudo={sudo} />}
        {tab === 'config' && (
          <>
            <div className="section-label">Ficheros de configuración</div>
            <FileLinks files={data.configFiles} onOpenFile={onOpenFile} empty="No se encontraron ficheros .cnf en las rutas habituales." />
          </>
        )}
        {tab === 'errors' && <FileLog server={server} files={data.errorLogs} title="Registro" />}
      </div>
    </div>
  )
}

function QueryTab({ server, query, sudo }: { server: ServerSummary; query: MysqlQuery; sudo: boolean }) {
  const call = useModuleCall(server)
  const [result, setResult] = useState<TableResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [kill, setKill] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setResult(await call('mysql.query', { query, sudo }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [call, query, sudo])

  useEffect(() => {
    void load()
  }, [load])

  const doKill = async (id: number) => {
    setKill(null)
    try {
      await call('mysql.kill', { id, sudo })
    } catch (err) {
      setError((err as Error).message)
    }
    void load()
  }

  return (
    <>
      <div className="service-actions">
        <button disabled={loading} onClick={() => void load()}>
          <Icon name="refresh" /> {loading ? 'Cargando…' : 'Actualizar'}
        </button>
        {query === 'databases' && result && (
          <span className="note">
            Total: {formatSize(result.rows.reduce((sum, r) => sum + Number(r[2] ?? 0), 0))} en {result.rows.length} bases de datos
          </span>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      {result && (
        <ResultTable
          result={result}
          format={{
            bytes: (v) => formatSize(Number(v ?? 0)),
            consulta: (v) => <span className="mono">{v ?? ''}</span>
          }}
          action={
            query === 'processlist'
              ? (row) => (
                  <button className="danger" onClick={() => setKill(Number(row[0]))}>
                    Matar
                  </button>
                )
              : undefined
          }
        />
      )}
      {kill !== null && (
        <ConfirmDialog title={`Matar el proceso ${kill}`} confirmLabel="Matar" danger onCancel={() => setKill(null)} onConfirm={() => void doKill(kill)}>
          {server.environment === 'prod' && <div className="notice error">Servidor de producción: {server.name}.</div>}
          Se ejecutará <code>KILL {kill}</code>: la conexión se corta y su transacción en curso se deshace.
        </ConfirmDialog>
      )}
    </>
  )
}
