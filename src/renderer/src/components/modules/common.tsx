import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { TableResult } from '@shared/modules'
import type { ServerSummary } from '@shared/types'
import { useModuleCall } from '../../lib/sudo'
import { LogBox } from './ServicePanel'

/** Final de un fichero de registro, a elegir entre varios. */
export function FileLog({ server, files, title }: { server: ServerSummary; files: string[]; title: string }) {
  const call = useModuleCall(server)
  const [path, setPath] = useState(files[0] ?? '')
  const [lines, setLines] = useState(200)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!path) return
    setLoading(true)
    setError(null)
    try {
      setText((await call('files.tail', { path, lines })).text)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [call, path, lines])

  useEffect(() => {
    void load()
  }, [load])

  if (!files.length) return <div className="empty-note">No se encontró el fichero de registro en las rutas habituales; mira el registro del servicio.</div>
  return (
    <LogBox
      title={title}
      text={text}
      error={error}
      loading={loading}
      onRefresh={() => void load()}
      lines={lines}
      onLines={setLines}
      extra={
        files.length > 1 ? (
          <select value={path} onChange={(e) => setPath(e.target.value)} style={{ width: 'auto' }}>
            {files.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        ) : (
          <span className="note mono">{path}</span>
        )
      }
    />
  )
}

/** Lista de ficheros que se abren en el editor con un clic. */
export function FileLinks({ files, onOpenFile, empty }: { files: string[]; onOpenFile: (path: string) => void; empty: string }) {
  if (!files.length) return <div className="empty-note">{empty}</div>
  return (
    <ul className="file-links">
      {files.map((f) => (
        <li key={f}>
          <button className="link mono" onClick={() => onOpenFile(f)} title="Abrir en el editor">
            {f}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Tabla simple de resultados, con formato opcional por columna y una acción por fila. */
export function ResultTable({
  result,
  format,
  action
}: {
  result: TableResult
  format?: Record<string, (value: string | null) => ReactNode>
  action?: (row: (string | null)[]) => ReactNode
}) {
  if (!result.rows.length) return <div className="empty-note">Sin filas.</div>
  return (
    <div className="result-table-wrap">
      <table className="result-table">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c}>{c.replace(/_/g, ' ')}</th>
            ))}
            {action && <th />}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {row.map((value, j) => {
                const column = result.columns[j]!
                return (
                  <td key={j} className={value === null ? 'null' : ''}>
                    {format?.[column] ? format[column](value) : (value ?? 'NULL')}
                  </td>
                )
              })}
              {action && <td className="row-action">{action(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Sub-pestañas dentro de la vista de un módulo. */
export function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (tab: T) => void }) {
  return (
    <div className="subtabs">
      {tabs.map(([id, label]) => (
        <div key={id} className={`subtab ${value === id ? 'active' : ''}`} onClick={() => onChange(id)}>
          {label}
        </div>
      ))}
    </div>
  )
}

/** Carga de datos con estado de carga y error, recargable. */
export function useLoad<T>(fn: () => Promise<T>): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const reload = useCallback(() => {
    setLoading(true)
    setError(null)
    fn().then(
      (value) => {
        setData(value)
        setLoading(false)
      },
      (err: Error) => {
        setError(err.message)
        setLoading(false)
      }
    )
  }, [fn])
  useEffect(reload, [reload])
  return { data, error, loading, reload }
}
