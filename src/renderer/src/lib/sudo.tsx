import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { SUDO_PASSWORD_REQUIRED, type ModuleCall, type ModuleCalls } from '@shared/modules'
import type { ServerSummary } from '@shared/types'

type Ask = (server: ServerSummary) => Promise<boolean>

const SudoContext = createContext<Ask>(async () => false)

/** Diálogo de la contraseña de sudo. Varias peticiones a la vez para el mismo servidor comparten diálogo. */
export function SudoProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ServerSummary | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(new Map<string, { promise: Promise<boolean>; resolve: (ok: boolean) => void }>())
  const queue = useRef<ServerSummary[]>([])
  const currentRef = useRef<ServerSummary | null>(null)

  const showNext = () => {
    const next = queue.current.shift() ?? null
    currentRef.current = next
    setCurrent(next)
    setPassword('')
    setError(null)
    setBusy(false)
  }

  const ask = useCallback<Ask>((server) => {
    const existing = pending.current.get(server.id)
    if (existing) return existing.promise
    let resolve: (ok: boolean) => void = () => {}
    const promise = new Promise<boolean>((r) => (resolve = r))
    pending.current.set(server.id, { promise, resolve })
    queue.current.push(server)
    if (!currentRef.current) showNext()
    return promise
    // showNext solo usa refs y setters estables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finish = (ok: boolean) => {
    if (!current) return
    pending.current.get(current.id)?.resolve(ok)
    pending.current.delete(current.id)
    showNext()
  }

  const submit = async () => {
    if (!current || !password) return
    setBusy(true)
    setError(null)
    try {
      await window.api.setSudoPassword(current.id, password)
      finish(true)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <SudoContext.Provider value={ask}>
      {children}
      {current && (
        <div className="modal-overlay">
          <form
            className="dialog narrow"
            onKeyDown={(e) => e.key === 'Escape' && !busy && finish(false)}
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <h2>Contraseña de sudo</h2>
            <div className="body">
              <p style={{ marginTop: 0 }}>
                Esta operación necesita permisos de administrador en <strong>{current.name}</strong>. Escribe la contraseña de sudo de{' '}
                <strong>{current.username}</strong>.
              </p>
              <input type="password" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
              <p className="note" style={{ marginBottom: 0 }}>
                Se guarda solo en memoria mientras dure la conexión.
              </p>
              {error && (
                <div className="notice error" style={{ marginTop: 10, marginBottom: 0 }}>
                  {error}
                </div>
              )}
            </div>
            <div className="footer">
              <div className="spacer" />
              <button type="button" disabled={busy} onClick={() => finish(false)}>
                Cancelar
              </button>
              <button type="submit" className="primary" disabled={busy || !password}>
                Continuar
              </button>
            </div>
          </form>
        </div>
      )}
    </SudoContext.Provider>
  )
}

/** Ejecuta `fn`; si el servidor pide la contraseña de sudo, la pregunta y lo reintenta. */
export function useSudo() {
  const ask = useContext(SudoContext)
  return useCallback(
    async <T,>(server: ServerSummary, fn: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn()
        } catch (err) {
          if ((err as Error).message !== SUDO_PASSWORD_REQUIRED || attempt >= 3) throw err
          if (!(await ask(server))) throw new Error('Cancelado: hace falta la contraseña de sudo')
        }
      }
    },
    [ask]
  )
}

/** Llamadas de los módulos de un servidor, con la contraseña de sudo resuelta sobre la marcha. */
export function useModuleCall(server: ServerSummary) {
  const withSudo = useSudo()
  return useCallback(
    <K extends ModuleCall>(call: K, args: ModuleCalls[K]['args']): Promise<ModuleCalls[K]['result']> =>
      withSudo(server, () => window.api.moduleCall(server.id, call, args)),
    [server, withSudo]
  )
}
