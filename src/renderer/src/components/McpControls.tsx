import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  claudeCodeCommand,
  effectiveAccess,
  MCP_ACCESS_LABEL,
  MCP_ACCESS_LEVELS,
  type McpAccess,
  type McpActivity,
  type McpApprovalRequest,
  type McpStatus
} from '@shared/mcp'
import type { ServerSummary } from '@shared/types'

/**
 * Servidor MCP para Claude: botón en la barra de estado (con indicador), diálogo de configuración
 * (activar, acceso por servidor, extensión de Claude Desktop, actividad) y aprobación de acciones.
 */
export function McpControls() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [activity, setActivity] = useState<McpActivity[]>([])
  const [approvals, setApprovals] = useState<McpApprovalRequest[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void window.api.mcpStatus().then(setStatus)
    void window.api.mcpActivity().then(setActivity)
    const offs = [
      window.api.onMcpStatus(setStatus),
      window.api.onMcpActivity((entry) => setActivity((list) => [entry, ...list].slice(0, 200))),
      window.api.onMcpApproval((request) => setApprovals((list) => [...list, request]))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  if (!status) return null
  const color = status.running ? 'var(--ok)' : status.enabled ? 'var(--danger)' : 'var(--text-dim)'
  const granted = Object.keys(status.access).length
  const title = status.running
    ? `Claude tiene acceso a ${granted} servidor(es) (${status.url})`
    : (status.error ?? 'Servidor MCP para Claude desactivado')

  const answer = (approved: boolean) => {
    const [first] = approvals
    if (!first) return
    setApprovals((list) => list.slice(1))
    void window.api.mcpRespondApproval(first.id, approved)
  }

  return (
    <>
      <button className="status-btn" title={title} onClick={() => setOpen(true)}>
        <span style={{ color }}>●</span> Claude MCP
      </button>
      {open && createPortal(<McpDialog status={status} activity={activity} onClose={() => setOpen(false)} />, document.body)}
      {approvals[0] && createPortal(<ApprovalDialog request={approvals[0]} pending={approvals.length - 1} onAnswer={answer} />, document.body)}
    </>
  )
}

const ENV_LABEL = { dev: 'Desarrollo', test: 'Pruebas', prod: 'PRODUCCIÓN' } as const

/** El agente quiere cambiar algo en un servidor: el usuario lo lee y decide. Por defecto, rechazar. */
function ApprovalDialog({ request, pending, onAnswer }: { request: McpApprovalRequest; pending: number; onAnswer: (ok: boolean) => void }) {
  const prod = request.environment === 'prod'
  return (
    <div className="modal-overlay">
      <div className="dialog" role="alertdialog" aria-label="Aprobar acción de Claude" onKeyDown={(e) => e.key === 'Escape' && onAnswer(false)}>
        <h2>Claude quiere actuar en un servidor</h2>
        <div className="body">
          <p>
            <strong>{request.serverName}</strong> ·{' '}
            {prod ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{ENV_LABEL.prod}</span> : ENV_LABEL[request.environment]}
          </p>
          <p>{request.title}</p>
          {request.sudo && <div className="notice warn">Se ejecuta como root (sudo).</div>}
          <pre
            className="mono"
            style={{ margin: 0, padding: 8, background: 'var(--bg)', borderRadius: 4, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 300, overflow: 'auto', userSelect: 'text' }}
          >
            {request.detail}
          </pre>
          {pending > 0 && <p className="note">Hay {pending} petición(es) más esperando.</p>}
        </div>
        <div className="footer">
          <span className="note">Si no respondes en 5 minutos, se rechaza.</span>
          <div className="spacer" />
          <button autoFocus onClick={() => onAnswer(false)}>
            Rechazar
          </button>
          <button className={prod || request.sudo ? 'danger' : 'primary'} onClick={() => onAnswer(true)}>
            Ejecutar
          </button>
        </div>
      </div>
    </div>
  )
}

function McpDialog({ status, activity, onClose }: { status: McpStatus; activity: McpActivity[]; onClose: () => void }) {
  const [servers, setServers] = useState<ServerSummary[]>([])
  const [showToken, setShowToken] = useState(false)
  const [port, setPort] = useState(String(status.port))
  const [copied, setCopied] = useState(false)
  const [extension, setExtension] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listServers().then(setServers)
  }, [])

  const run = (action: Promise<unknown>) => void action.then(() => setError(null), (err: Error) => setError(err.message))
  const command = claudeCodeCommand(status)
  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535

  const createExtension = () =>
    void window.api.mcpCreateExtension().then(
      (path) => {
        if (path) setExtension(path)
        setError(null)
      },
      (err: Error) => setError(err.message)
    )

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 700 }} role="dialog" aria-label="Servidor MCP para Claude" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>Servidor MCP para Claude</h2>
        <div className="body">
          <p className="note">
            Deja que Claude (Claude Desktop, Claude Code…) analice y, si lo permites, administre los servidores a los que le des acceso. Las
            contraseñas no salen de la app. Escucha solo en este equipo (127.0.0.1) y pide un token.
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
          </div>

          <div className="section-label" style={{ marginTop: 14 }}>
            Acceso por servidor
          </div>
          <p className="note" style={{ marginTop: 0 }}>
            <b>Solo lectura</b>: accesos SSH, conexiones, sesiones, fail2ban, cortafuegos, servicios y registros. <b>Ejecución</b>: además
            ejecutar comandos, banear IPs y gestionar servicios. En producción siempre pide aprobación. Si el servidor no está conectado, Claude
            abre su propia conexión con los datos guardados.
          </p>
          {servers.length === 0 ? (
            <p className="note">No hay servidores guardados.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', alignItems: 'center' }}>
              {servers.map((s) => {
                const wanted = status.access[s.id] ?? 'off'
                const effective = effectiveAccess(s.environment, wanted)
                return (
                  <ServerAccessRow
                    key={s.id}
                    server={s}
                    value={effective}
                    onChange={(level) => run(window.api.mcpSetAccess(s.id, level))}
                  />
                )
              })}
            </div>
          )}

          <div className="section-label" style={{ marginTop: 14 }}>
            Claude Desktop
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="compact primary" onClick={createExtension}>
              Crear extensión (.mcpb)…
            </button>
            {extension && (
              <button className="compact" onClick={() => run(window.api.mcpOpenExtension())}>
                Instalar en Claude Desktop
              </button>
            )}
          </div>
          <p className="note">
            {extension ? (
              <>
                Guardada en <span className="mono">{extension}</span>. Ábrela o arrástrala a Claude Desktop (Ajustes → Extensiones).
              </>
            ) : (
              'Un fichero que Claude Desktop instala con doble clic. Lee el puerto y el token de la app: no hay que reinstalarla si cambian.'
            )}
          </p>

          <div className="section-label" style={{ marginTop: 14 }}>
            Claude Code
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>
              {showToken ? command : command.replace(status.token, '•'.repeat(12))}
            </code>
            <button className="compact" onClick={() => setShowToken((v) => !v)}>
              {showToken ? 'Ocultar' : 'Ver'}
            </button>
            <button
              className="compact"
              onClick={() =>
                void navigator.clipboard.writeText(command).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }
            >
              {copied ? 'Copiado' : 'Copiar'}
            </button>
            <button className="compact" onClick={() => run(window.api.mcpRegenerateToken())} title="Los clientes con el token anterior dejarán de funcionar (la extensión de Claude Desktop no)">
              Regenerar token
            </button>
          </div>

          <div className="section-label" style={{ marginTop: 14 }}>
            Actividad reciente
          </div>
          {activity.length === 0 ? (
            <p className="note">Claude aún no ha hecho ninguna consulta.</p>
          ) : (
            <div style={{ maxHeight: 180, overflow: 'auto', fontSize: 12 }}>
              {activity.map((a, i) => (
                <div key={i} title={a.error ?? a.detail} style={{ display: 'flex', gap: 8, padding: '2px 0', whiteSpace: 'nowrap' }}>
                  <span className="note">{new Date(a.time).toLocaleTimeString()}</span>
                  <span style={{ color: a.ok ? 'var(--ok)' : 'var(--danger)' }}>{a.ok ? '✓' : '✗'}</span>
                  <span className="mono">{a.tool}</span>
                  {a.server && <span className="note">{a.server}</span>}
                  {(a.error ?? a.detail) && (
                    <span className={a.detail && !a.error ? 'mono note' : 'note'} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {a.error ?? a.detail}
                    </span>
                  )}
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

function ServerAccessRow({ server, value, onChange }: { server: ServerSummary; value: McpAccess; onChange: (level: McpAccess) => void }) {
  const prod = server.environment === 'prod'
  return (
    <>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {server.name} <span className="note">{server.username}@{server.host}</span>
        {prod && <span style={{ color: 'var(--danger)', fontSize: 11, marginLeft: 6 }}>PROD</span>}
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value as McpAccess)}>
        {MCP_ACCESS_LEVELS.filter((level) => !(prod && level === 'execute')).map((level) => (
          <option key={level} value={level}>
            {MCP_ACCESS_LABEL[level]}
          </option>
        ))}
      </select>
    </>
  )
}
