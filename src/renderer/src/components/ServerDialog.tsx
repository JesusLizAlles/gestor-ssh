import { useState } from 'react'
import type { AuthMethod, SaveServerInput, SecretKey, SecretsPatch, SecretStorageStatus, ServerConfig, ServerSummary } from '@shared/types'

type Draft = Omit<ServerConfig, 'id'> & { id?: string }

function emptyDraft(): Draft {
  return {
    name: '',
    host: '',
    port: 22,
    username: '',
    authMethod: 'privateKey',
    privateKeyPath: '',
    environment: 'dev',
    initialPath: ''
  }
}

/** `usuario@servidor:puerto` pegado en el campo del servidor se reparte entre los tres campos. */
function parseTarget(value: string): Partial<Draft> | null {
  const match = /^(?:ssh:\/\/)?(?:([^@\s]+)@)?([^:@\s/]+)(?::(\d{1,5}))?\/?$/.exec(value.trim())
  if (!match || (!match[1] && !match[3])) return null
  return {
    host: match[2]!,
    ...(match[1] ? { username: match[1] } : {}),
    ...(match[3] ? { port: Number(match[3]) } : {})
  }
}

interface Props {
  initial: ServerSummary | null
  /** Datos de partida para un servidor nuevo (al duplicar otro). */
  template?: ServerSummary | null
  secretStatus: SecretStorageStatus | null
  onClose: () => void
  onSaved: (saved: ServerSummary) => void
}

/** Campo de secreto: vacío = conservar el guardado; «Olvidar» lo borra. */
function SecretField(props: { label: string; name: SecretKey; stored: boolean; values: SecretsPatch; onChange: (patch: SecretsPatch) => void }) {
  const value = props.values[props.name]
  const forgotten = value === null
  return (
    <>
      <label htmlFor={`secret-${props.name}`}>{props.label}</label>
      <div className="row">
        <input
          id={`secret-${props.name}`}
          type="password"
          autoComplete="off"
          placeholder={props.stored && !forgotten ? '•••••••• (guardada; déjalo vacío para conservarla)' : ''}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => props.onChange({ ...props.values, [props.name]: e.target.value || undefined })}
        />
        {props.stored && !forgotten && (
          <button type="button" className="link" onClick={() => props.onChange({ ...props.values, [props.name]: null })}>
            Olvidar
          </button>
        )}
      </div>
    </>
  )
}

const AUTH_LABELS: Record<AuthMethod, string> = { privateKey: 'Clave privada', password: 'Contraseña', agent: 'Agente SSH' }

export function ServerDialog({ initial, template, secretStatus, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<Draft>(() => {
    const source = initial ?? template
    if (!source) return emptyDraft()
    const { storedSecrets: _stored, id, ...config } = source
    return initial ? { ...config, id } : config
  })
  const [secrets, setSecrets] = useState<SecretsPatch>({})
  const [busy, setBusy] = useState<'test' | 'save' | 'forget' | null>(null)
  const [result, setResult] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const stored = new Set(initial?.storedSecrets ?? [])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  const input = (): SaveServerInput => {
    // Solo se mandan los secretos del método elegido; los otros se olvidan al guardar.
    const patch: SecretsPatch = {}
    if (draft.authMethod === 'password') {
      if (secrets.password !== undefined) patch.password = secrets.password
      if (stored.has('passphrase')) patch.passphrase = null
    } else if (draft.authMethod === 'privateKey') {
      if (secrets.passphrase !== undefined) patch.passphrase = secrets.passphrase
      if (stored.has('password')) patch.password = null
    } else {
      if (stored.has('password')) patch.password = null
      if (stored.has('passphrase')) patch.passphrase = null
    }
    return { config: { ...draft, name: draft.name.trim() || draft.host.trim() }, secrets: patch }
  }

  const test = async () => {
    setBusy('test')
    setResult(null)
    try {
      const r = await window.api.testServer(input())
      setResult({ kind: 'ok', text: `Conexión correcta. ${r.system ? `${r.system}. ` : ''}Carpeta personal: ${r.home}. Huella: ${r.fingerprint}` })
    } catch (err) {
      setResult({ kind: 'error', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    setResult(null)
    try {
      onSaved(await window.api.saveServer(input()))
    } catch (err) {
      setResult({ kind: 'error', text: (err as Error).message })
      setBusy(null)
    }
  }

  const forgetFingerprint = async () => {
    if (!initial) return
    setBusy('forget')
    try {
      await window.api.forgetHostKey(initial.id)
      setResult({ kind: 'warn', text: 'Huella olvidada: la próxima conexión pedirá aceptar la huella nueva.' })
    } catch (err) {
      setResult({ kind: 'error', text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const pickKey = async () => {
    const path = await window.api.pickPrivateKey()
    if (path) set('privateKeyPath', path)
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="dialog"
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h2>{initial ? `Editar ${initial.name}` : 'Nuevo servidor'}</h2>
        <div className="body">
          {secretStatus && !secretStatus.persistent && (
            <div className="notice warn">
              No hay llavero del sistema disponible ({secretStatus.backend}): las contraseñas solo se recuerdan mientras la app esté abierta.
            </div>
          )}
          <div className="form-grid">
            <label htmlFor="srv-name">Nombre</label>
            <input id="srv-name" autoFocus value={draft.name} placeholder={draft.host || 'Web producción'} onChange={(e) => set('name', e.target.value)} />

            <label htmlFor="srv-host">Servidor</label>
            <div className="row">
              <input
                id="srv-host"
                value={draft.host}
                placeholder="servidor.ejemplo.com o usuario@servidor:22"
                onChange={(e) => set('host', e.target.value)}
                onBlur={(e) => {
                  const parsed = parseTarget(e.target.value)
                  if (parsed) setDraft((d) => ({ ...d, ...parsed }))
                }}
              />
              <input
                className="port"
                type="number"
                min={1}
                max={65535}
                aria-label="Puerto"
                value={draft.port}
                onChange={(e) => set('port', Number(e.target.value) || 22)}
              />
            </div>

            <label htmlFor="srv-user">Usuario</label>
            <input id="srv-user" value={draft.username} placeholder="root" onChange={(e) => set('username', e.target.value)} />

            <label>Autenticación</label>
            <div className="segmented" role="radiogroup">
              {(Object.keys(AUTH_LABELS) as AuthMethod[]).map((method) => (
                <button
                  key={method}
                  type="button"
                  role="radio"
                  aria-checked={draft.authMethod === method}
                  className={draft.authMethod === method ? 'active' : ''}
                  onClick={() => set('authMethod', method)}
                >
                  {AUTH_LABELS[method]}
                </button>
              ))}
            </div>

            {draft.authMethod === 'password' && (
              <SecretField label="Contraseña" name="password" stored={stored.has('password')} values={secrets} onChange={setSecrets} />
            )}
            {draft.authMethod === 'privateKey' && (
              <>
                <label htmlFor="srv-key">Fichero de clave</label>
                <div className="row">
                  <input id="srv-key" value={draft.privateKeyPath} placeholder="~/.ssh/id_ed25519" onChange={(e) => set('privateKeyPath', e.target.value)} />
                  <button type="button" onClick={() => void pickKey()}>
                    Elegir…
                  </button>
                </div>
                <SecretField label="Frase de paso" name="passphrase" stored={stored.has('passphrase')} values={secrets} onChange={setSecrets} />
              </>
            )}
            {draft.authMethod === 'agent' && (
              <div className="full note">Se usan las claves cargadas en el agente SSH del sistema (ssh-agent, Pageant u OpenSSH de Windows).</div>
            )}

            <label htmlFor="srv-env">Entorno</label>
            <select id="srv-env" value={draft.environment} onChange={(e) => set('environment', e.target.value as Draft['environment'])}>
              <option value="dev">Desarrollo</option>
              <option value="test">Pruebas</option>
              <option value="prod">Producción</option>
            </select>

            <label htmlFor="srv-path">Carpeta inicial</label>
            <input id="srv-path" value={draft.initialPath} placeholder="Carpeta personal (~)" onChange={(e) => set('initialPath', e.target.value)} />
          </div>
          {result && (
            <div className={`notice ${result.kind}`} style={{ marginTop: 12, marginBottom: 0 }}>
              {result.text}
            </div>
          )}
        </div>
        <div className="footer">
          {initial && (
            <button type="button" className="link" disabled={!!busy} onClick={() => void forgetFingerprint()} title="Si el servidor se reinstaló y su huella cambió">
              Olvidar huella
            </button>
          )}
          <div className="spacer" />
          <button type="button" disabled={!!busy || !draft.host.trim() || !draft.username.trim()} onClick={() => void test()}>
            {busy === 'test' ? 'Probando…' : 'Probar conexión'}
          </button>
          <button type="button" disabled={!!busy} onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={!!busy || !draft.host.trim() || !draft.username.trim()}>
            Guardar
          </button>
        </div>
      </form>
    </div>
  )
}
