import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { claudeCodeCommand, claudeDesktopConfig, type McpActivity, type McpStatus } from '@shared/mcp'

/**
 * Servidor MCP para Claude: botón en la barra de estado (con indicador) y diálogo para activarlo,
 * copiar la configuración de los clientes y ver qué ha consultado Claude.
 */
export function McpControls() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [activity, setActivity] = useState<McpActivity[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void window.api.mcpStatus().then(setStatus)
    void window.api.mcpActivity().then(setActivity)
    const offStatus = window.api.onMcpStatus(setStatus)
    const offActivity = window.api.onMcpActivity((entry) => setActivity((list) => [entry, ...list].slice(0, 200)))
    return () => {
      offStatus()
      offActivity()
    }
  }, [])

  if (!status) return null
  const color = status.running ? 'var(--ok)' : status.enabled ? 'var(--danger)' : 'var(--text-dim)'
  const title = status.running ? `Claude puede consultar los servidores conectados (${status.url})` : status.error ?? 'Servidor MCP para Claude desactivado'

  return (
    <>
      <button className="status-btn" title={title} onClick={() => setOpen(true)}>
        <span style={{ color }}>●</span> Claude MCP
      </button>
      {open && createPortal(<McpDialog status={status} activity={activity} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function McpDialog({ status, activity, onClose }: { status: McpStatus; activity: McpActivity[]; onClose: () => void }) {
  const [showToken, setShowToken] = useState(false)
  const [port, setPort] = useState(String(status.port))
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = (action: Promise<unknown>) => void action.then(() => setError(null), (err: Error) => setError(err.message))
  const copy = (key: string, text: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000)
    })
  const mask = (text: string) => (showToken ? text : text.replaceAll(status.token, '•'.repeat(12)))
  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Servidor MCP para Claude" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>Servidor MCP para Claude</h2>
        <div className="body">
          <p className="note">
            Permite que Claude (Claude Code, Claude Desktop…) analice la seguridad y el estado de los servidores <b>que tengas conectados</b>:
            accesos SSH, conexiones y puertos, sesiones, fail2ban, cortafuegos y servicios. Solo lectura: Claude no puede cambiar nada ni ve
            contraseñas. Escucha únicamente en este equipo (127.0.0.1) y pide el token.
          </p>
          {status.error && <div className="notice error">{status.error}</div>}
          {error && <div className="notice error">{error}</div>}

          <div className="form-grid">
            <label>Estado</label>
            <label className="check">
              <input type="checkbox" checked={status.enabled} onChange={(e) => run(window.api.mcpSetEnabled(e.target.checked))} />
              {status.running ? 'Activado' : status.enabled ? 'Activado, pero no está escuchando' : 'Desactivado'}
            </label>

            <label>Puerto</label>
            <div className="row">
              <input className="port" value={port} onChange={(e) => setPort(e.target.value)} />
              <button className="compact" disabled={!portValid || portNumber === status.port} onClick={() => run(window.api.mcpSetPort(portNumber))}>
                Aplicar
              </button>
            </div>

            <label>Token</label>
            <div className="row">
              <code className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'text' }}>
                {showToken ? status.token : '•'.repeat(24)}
              </code>
              <button className="compact" onClick={() => setShowToken((v) => !v)}>
                {showToken ? 'Ocultar' : 'Ver'}
              </button>
              <button className="compact" onClick={() => run(window.api.mcpRegenerateToken())} title="Los clientes configurados con el token anterior dejarán de funcionar">
                Regenerar
              </button>
            </div>
          </div>

          <Snippet label="Claude Code" text={claudeCodeCommand(status)} display={mask} copied={copied === 'code'} onCopy={(t) => copy('code', t)} />
          <Snippet
            label="Claude Desktop (claude_desktop_config.json, necesita Node.js)"
            text={claudeDesktopConfig(status)}
            display={mask}
            copied={copied === 'desktop'}
            onCopy={(t) => copy('desktop', t)}
          />

          <div className="section-label" style={{ marginTop: 14 }}>
            Actividad reciente
          </div>
          {activity.length === 0 ? (
            <p className="note">Claude aún no ha hecho ninguna consulta.</p>
          ) : (
            <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 12 }}>
              {activity.map((a, i) => (
                <div key={i} title={a.error} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                  <span className="note">{new Date(a.time).toLocaleTimeString()}</span>
                  <span style={{ color: a.ok ? 'var(--ok)' : 'var(--danger)' }}>{a.ok ? '✓' : '✗'}</span>
                  <span className="mono">{a.tool}</span>
                  {a.server && <span className="note">{a.server}</span>}
                  {a.error && <span className="note" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="footer">
          <div className="spacer" />
          <button className="primary" autoFocus onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}

function Snippet(props: { label: string; text: string; display: (t: string) => string; copied: boolean; onCopy: (t: string) => void }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <span className="note" style={{ flex: 1 }}>
          {props.label}
        </span>
        <button className="compact" onClick={() => props.onCopy(props.text)}>
          {props.copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre className="mono" style={{ margin: 0, padding: 8, background: 'var(--bg)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'text' }}>
        {props.display(props.text)}
      </pre>
    </div>
  )
}
