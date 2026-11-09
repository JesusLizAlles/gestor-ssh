import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isListening,
  isLoopback,
  isMulticast,
  isPrivate,
  isWildcard,
  summarizeFailures,
  type ConnectionsResult,
  type Fail2banResult,
  type FailureSummary,
  type FirewallResult,
  type SessionsResult,
  type SocketEntry,
  type SshLogResult,
  type SshPeriod
} from '@shared/security'
import type { ServerSummary } from '@shared/types'
import { useModuleCall } from '../../lib/sudo'
import { ConfirmDialog } from '../ConfirmDialog'
import { Icon } from '../Icon'
import { SubTabs } from './common'

interface Props {
  server: ServerSummary
}

type Tab = 'summary' | 'connections' | 'ports' | 'ssh' | 'sessions' | 'fail2ban' | 'firewall'
type BanRequest = { ip: string; jail: string; ban: boolean }

/** «Usar sudo» por servidor (comodidad: se recuerda en este equipo). */
function useStoredFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored === null ? initial : stored === '1'
    } catch {
      return initial
    }
  })
  return [
    value,
    (next) => {
      setValue(next)
      try {
        localStorage.setItem(key, next ? '1' : '0')
      } catch {
        // Sin almacenamiento: dura lo que la pestaña.
      }
    }
  ]
}

/** Carga con estado; `deps` cambia → se vuelve a cargar. `intervalMs` refresca solo. */
function useData<T>(fn: () => Promise<T>, intervalMs: number | null = null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await fn())
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [fn])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!intervalMs) return
    const timer = setInterval(() => void load(), intervalMs)
    return () => clearInterval(timer)
  }, [load, intervalMs])
  return { data, error, loading, reload: load }
}

const ipKind = (ip: string) => (isLoopback(ip) ? 'local' : isMulticast(ip) ? 'multidifusión' : isPrivate(ip) ? 'red interna' : 'Internet')

/** Lista de puertos corta: los 5 primeros y cuántos más. */
const portList = (ports: Set<string>) => {
  const sorted = [...ports].sort((a, b) => Number(a) - Number(b))
  return sorted.length > 5 ? `${sorted.slice(0, 5).join(', ')} y ${sorted.length - 5} más` : sorted.join(', ')
}

/** Conexiones establecidas agrupadas por IP remota. */
function groupByPeer(sockets: SocketEntry[], hideLocal: boolean) {
  const groups = new Map<string, { ip: string; count: number; localPorts: Set<string>; processes: Set<string> }>()
  for (const s of sockets) {
    if (s.proto !== 'tcp' || s.state !== 'ESTAB') continue
    if (hideLocal && isLoopback(s.peerAddress)) continue
    const g = groups.get(s.peerAddress) ?? { ip: s.peerAddress, count: 0, localPorts: new Set<string>(), processes: new Set<string>() }
    g.count++
    g.localPorts.add(s.localPort)
    if (s.process) g.processes.add(s.process)
    groups.set(s.peerAddress, g)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

export function SecurityView({ server }: Props) {
  const call = useModuleCall(server)
  const [tab, setTab] = useState<Tab>('summary')
  const [sudo, setSudo] = useStoredFlag(`security-sudo:${server.id}`, false)
  const [ban, setBan] = useState<BanRequest | null>(null)
  const [banMessage, setBanMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // fail2ban siempre necesita root; se pide solo si el usuario ha activado sudo o abre su pestaña.
  const fail2ban = useData(
    useCallback(
      () => (sudo || tab === 'fail2ban' ? call('security.fail2ban', {}) : Promise.resolve<Fail2banResult | null>(null)),
      // refreshKey: tras bloquear o desbloquear.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [call, sudo, tab === 'fail2ban', refreshKey]
    )
  )
  const sshJail = fail2ban.data?.jails.find((j) => j.name === 'sshd' || j.name === 'ssh')?.name ?? null

  const doBan = async (request: BanRequest) => {
    setBan(null)
    setBanMessage(null)
    try {
      await call('security.ban', request)
      setBanMessage({ kind: 'ok', text: `${request.ip} ${request.ban ? 'bloqueada' : 'desbloqueada'} en la jail ${request.jail}.` })
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setBanMessage({ kind: 'error', text: (err as Error).message })
    }
  }

  const banButton = (ip: string) =>
    sshJail && !isPrivate(ip) ? (
      <button className="danger" onClick={() => setBan({ ip, jail: sshJail, ban: true })} title={`Bloquear con fail2ban (jail ${sshJail})`}>
        Bloquear
      </button>
    ) : null

  return (
    <div className="module-view">
      <div className="module-header">
        <Icon name="shield" />
        <strong>Seguridad</strong>
        <div className="spacer" />
        <label className="check note" title="Con sudo se ven los procesos de todos los usuarios, el registro de accesos completo y fail2ban">
          <input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} /> Usar sudo
        </label>
        <button className="icon" title="Actualizar todo" onClick={() => setRefreshKey((k) => k + 1)}>
          <Icon name="refresh" />
        </button>
      </div>
      <SubTabs
        tabs={[
          ['summary', 'Resumen'],
          ['connections', 'Conexiones'],
          ['ports', 'Puertos abiertos'],
          ['ssh', 'Accesos SSH'],
          ['sessions', 'Sesiones'],
          ['fail2ban', 'Fail2ban'],
          ['firewall', 'Cortafuegos']
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="module-body">
        {!sudo && tab !== 'fail2ban' && tab !== 'firewall' && (
          <div className="notice warn">
            Sin sudo no se ven los procesos de otros usuarios y puede faltar parte del registro de accesos.{' '}
            <button className="link" onClick={() => setSudo(true)}>
              Usar sudo
            </button>
          </div>
        )}
        {banMessage && <div className={`notice ${banMessage.kind}`}>{banMessage.text}</div>}
        {tab === 'summary' && <SummaryTab key={`${sudo}-${refreshKey}`} call={call} sudo={sudo} fail2ban={fail2ban.data} banButton={banButton} />}
        {tab === 'connections' && <ConnectionsTab key={`${sudo}-${refreshKey}`} call={call} sudo={sudo} />}
        {tab === 'ports' && <PortsTab key={`${sudo}-${refreshKey}`} call={call} sudo={sudo} />}
        {tab === 'ssh' && <SshTab key={`${sudo}-${refreshKey}`} call={call} sudo={sudo} banButton={banButton} />}
        {tab === 'sessions' && <SessionsTab key={refreshKey} call={call} />}
        {tab === 'fail2ban' && (
          <Fail2banTab data={fail2ban.data} error={fail2ban.error} loading={fail2ban.loading} onUnban={(ip, jail) => setBan({ ip, jail, ban: false })} onBan={(ip, jail) => setBan({ ip, jail, ban: true })} />
        )}
        {tab === 'firewall' && <FirewallTab key={refreshKey} call={call} />}
      </div>
      {ban && (
        <ConfirmDialog
          title={ban.ban ? `Bloquear ${ban.ip}` : `Desbloquear ${ban.ip}`}
          confirmLabel={ban.ban ? 'Bloquear' : 'Desbloquear'}
          danger={ban.ban}
          onCancel={() => setBan(null)}
          onConfirm={() => void doBan(ban)}
        >
          {ban.ban
            ? `fail2ban bloqueará ${ban.ip} en la jail «${ban.jail}» durante el tiempo configurado en ella (bantime).`
            : `fail2ban dejará de bloquear ${ban.ip} en la jail «${ban.jail}».`}
        </ConfirmDialog>
      )}
    </div>
  )
}

type Call = ReturnType<typeof useModuleCall>

function Stat({ label, value, tone, onClick }: { label: string; value: string | number; tone?: 'ok' | 'warn' | 'error'; onClick?: () => void }) {
  return (
    <div className={`stat-card ${tone ?? ''} ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function SummaryTab({
  call,
  sudo,
  fail2ban,
  banButton
}: {
  call: Call
  sudo: boolean
  fail2ban: Fail2banResult | null
  banButton: (ip: string) => React.ReactNode
}) {
  const connections = useData(useCallback(() => call('security.connections', { sudo }), [call, sudo]))
  const ssh = useData(useCallback(() => call('security.ssh', { sudo, hours: 24 }), [call, sudo]))
  const sessions = useData(useCallback(() => call('security.sessions', {}), [call]))

  const sockets = connections.data?.sockets ?? []
  const established = sockets.filter((s) => s.proto === 'tcp' && s.state === 'ESTAB' && !isLoopback(s.peerAddress))
  const peers = groupByPeer(sockets, true)
  const exposed = sockets.filter((s) => isListening(s) && isWildcard(s.localAddress))
  const failures = useMemo(() => summarizeFailures(ssh.data?.events ?? []), [ssh.data])
  const failedTotal = failures.reduce((sum, f) => sum + f.attempts, 0)
  const accepted = (ssh.data?.events ?? []).filter((e) => e.kind === 'accepted')
  const banned = fail2ban?.jails.reduce((sum, j) => sum + j.currentlyBanned, 0)

  return (
    <>
      {[connections.error, ssh.error, sessions.error].filter(Boolean).map((e) => (
        <div key={e} className="notice error">
          {e}
        </div>
      ))}
      <div className="stat-grid">
        <Stat label="Conexiones establecidas" value={connections.data ? established.length : '…'} />
        <Stat label="IPs remotas distintas" value={connections.data ? peers.length : '…'} />
        <Stat label="Puertos expuestos a la red" value={connections.data ? new Set(exposed.map((s) => `${s.proto}/${s.localPort}`)).size : '…'} tone={exposed.length > 6 ? 'warn' : undefined} />
        <Stat
          label="Intentos SSH fallidos (24 h)"
          value={ssh.data ? failedTotal : '…'}
          tone={failedTotal > 100 ? 'error' : failedTotal > 0 ? 'warn' : 'ok'}
        />
        <Stat label="IPs atacando por SSH (24 h)" value={ssh.data ? failures.length : '…'} />
        <Stat label="Accesos SSH correctos (24 h)" value={ssh.data ? accepted.length : '…'} />
        <Stat label="Usuarios conectados" value={sessions.data ? sessions.data.who.length : '…'} />
        <Stat
          label="IPs bloqueadas (fail2ban)"
          value={fail2ban ? (fail2ban.installed ? (banned ?? 0) : 'no instalado') : sudo ? '…' : 'requiere sudo'}
        />
      </div>

      <div className="two-cols">
        <div>
          <div className="section-label">Más intentos fallidos (24 h)</div>
          <FailuresTable failures={failures.slice(0, 10)} banButton={banButton} empty={ssh.loading ? 'Cargando…' : 'Ningún intento fallido.'} />
        </div>
        <div>
          <div className="section-label">IPs conectadas ahora</div>
          {peers.length ? (
            <table className="result-table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th>Origen</th>
                  <th className="num">Conexiones</th>
                  <th>Puertos locales</th>
                </tr>
              </thead>
              <tbody>
                {peers.slice(0, 10).map((p) => (
                  <tr key={p.ip}>
                    <td className="mono">
                      {p.ip}
                      {p.ip === connections.data?.clientIp && <span className="badge" style={{ marginLeft: 6 }}>tú</span>}
                    </td>
                    <td className="note">{ipKind(p.ip)}</td>
                    <td className="num">{p.count}</td>
                    <td className="mono">{portList(p.localPorts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-note">{connections.loading ? 'Cargando…' : 'Ninguna conexión remota.'}</div>
          )}
        </div>
      </div>
    </>
  )
}

function FailuresTable({ failures, banButton, empty }: { failures: FailureSummary[]; banButton: (ip: string) => React.ReactNode; empty: string }) {
  if (!failures.length) return <div className="empty-note">{empty}</div>
  return (
    <table className="result-table">
      <thead>
        <tr>
          <th>IP</th>
          <th className="num">Intentos</th>
          <th>Usuarios probados</th>
          <th>Último</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {failures.map((f) => (
          <tr key={f.ip}>
            <td className="mono" title={ipKind(f.ip)}>
              {f.ip}
            </td>
            <td className="num">{f.attempts}</td>
            <td title={f.users.join(', ')}>
              {f.users.slice(0, 4).join(', ')}
              {f.users.length > 4 ? ` y ${f.users.length - 4} más` : ''}
            </td>
            <td className="note">{f.last}</td>
            <td className="row-action">{banButton(f.ip)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ConnectionsTab({ call, sudo }: { call: Call; sudo: boolean }) {
  const [auto, setAuto] = useState(false)
  const [hideLocal, setHideLocal] = useState(true)
  const [view, setView] = useState<'peers' | 'all'>('peers')
  const [filter, setFilter] = useState('')
  const { data, error, loading, reload } = useData(
    useCallback(() => call('security.connections', { sudo }), [call, sudo]),
    auto ? 5000 : null
  )
  const sockets: SocketEntry[] = (data as ConnectionsResult | null)?.sockets ?? []
  const needle = filter.trim().toLowerCase()
  const peers = groupByPeer(sockets, hideLocal).filter((p) => !needle || p.ip.includes(needle) || [...p.processes].some((x) => x.toLowerCase().includes(needle)))
  const all = sockets.filter(
    (s) =>
      !isListening(s) &&
      (!hideLocal || !isLoopback(s.peerAddress)) &&
      (!needle || `${s.peerAddress} ${s.localPort} ${s.peerPort} ${s.process ?? ''} ${s.state}`.toLowerCase().includes(needle))
  )

  return (
    <>
      <div className="service-actions">
        <div className="segmented" style={{ width: 220 }}>
          <button className={view === 'peers' ? 'active' : ''} onClick={() => setView('peers')}>
            Por IP
          </button>
          <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>
            Todas
          </button>
        </div>
        <input placeholder="Filtrar por IP, puerto o proceso…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 240 }} />
        <label className="check note">
          <input type="checkbox" checked={hideLocal} onChange={(e) => setHideLocal(e.target.checked)} /> Ocultar localhost
        </label>
        <label className="check note" title="Vuelve a consultar cada 5 segundos">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Actualizar cada 5 s
        </label>
        <button className="icon" title="Actualizar" disabled={loading} onClick={() => void reload()}>
          <Icon name="refresh" />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {view === 'peers' ? (
        peers.length ? (
          <table className="result-table">
            <thead>
              <tr>
                <th>IP remota</th>
                <th>Origen</th>
                <th className="num">Conexiones</th>
                <th>Puertos locales</th>
                <th>Procesos</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((p) => (
                <tr key={p.ip}>
                  <td className="mono">
                    {p.ip}
                    {p.ip === data?.clientIp && <span className="badge" style={{ marginLeft: 6 }}>tú</span>}
                  </td>
                  <td className="note">{ipKind(p.ip)}</td>
                  <td className="num">{p.count}</td>
                  <td className="mono">{portList(p.localPorts)}</td>
                  <td>{[...p.processes].join(', ') || <span className="note">{sudo ? '—' : 'requiere sudo'}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-note">{loading ? 'Cargando…' : 'Ninguna conexión establecida.'}</div>
        )
      ) : (
        <table className="result-table">
          <thead>
            <tr>
              <th>Proto</th>
              <th>Estado</th>
              <th>Local</th>
              <th>Remoto</th>
              <th>Proceso</th>
            </tr>
          </thead>
          <tbody>
            {all.map((s, i) => (
              <tr key={i}>
                <td>{s.proto}</td>
                <td className="note">{s.state}</td>
                <td className="mono">
                  {s.localAddress}:{s.localPort}
                </td>
                <td className="mono">
                  {s.peerAddress}:{s.peerPort}
                </td>
                <td>{s.process ? `${s.process} (${s.pid})` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function PortsTab({ call, sudo }: { call: Call; sudo: boolean }) {
  const { data, error, loading, reload } = useData(useCallback(() => call('security.connections', { sudo }), [call, sudo]))
  const listening = (data?.sockets ?? [])
    .filter(isListening)
    .sort((a, b) => Number(a.localPort) - Number(b.localPort) || a.proto.localeCompare(b.proto))
  return (
    <>
      <div className="service-actions">
        <span className="note">
          «Expuesto» = escucha en todas las interfaces (0.0.0.0 o ::): se puede llegar desde fuera si el cortafuegos lo permite.
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon" title="Actualizar" disabled={loading} onClick={() => void reload()}>
          <Icon name="refresh" />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      <table className="result-table">
        <thead>
          <tr>
            <th>Proto</th>
            <th className="num">Puerto</th>
            <th>Dirección</th>
            <th>Alcance</th>
            <th>Proceso</th>
          </tr>
        </thead>
        <tbody>
          {listening.map((s, i) => (
            <tr key={i}>
              <td>{s.proto}</td>
              <td className="num mono">{s.localPort}</td>
              <td className="mono">{s.localAddress}</td>
              <td>
                {isWildcard(s.localAddress) ? (
                  <span className="state-pill warn">Expuesto</span>
                ) : isLoopback(s.localAddress) ? (
                  <span className="state-pill ok">Solo local</span>
                ) : (
                  <span className="state-pill">{ipKind(s.localAddress)}</span>
                )}
              </td>
              <td>{s.process ? `${s.process} (${s.pid})` : <span className="note">{sudo ? '—' : 'requiere sudo'}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && !listening.length && !error && <div className="empty-note">No hay puertos a la escucha.</div>}
    </>
  )
}

const PERIODS: [SshPeriod, string][] = [
  [24, 'Últimas 24 h'],
  [168, 'Últimos 7 días'],
  [720, 'Últimos 30 días']
]

function SshTab({ call, sudo, banButton }: { call: Call; sudo: boolean; banButton: (ip: string) => React.ReactNode }) {
  const [hours, setHours] = useState<SshPeriod>(24)
  const { data, error, loading, reload } = useData(useCallback(() => call('security.ssh', { sudo, hours }), [call, sudo, hours]))
  const result = data as SshLogResult | null
  const failures = useMemo(() => summarizeFailures(result?.events ?? []), [result])
  const accepted = (result?.events ?? []).filter((e) => e.kind === 'accepted').reverse()

  return (
    <>
      <div className="service-actions">
        <select value={hours} onChange={(e) => setHours(Number(e.target.value) as SshPeriod)} style={{ width: 'auto' }}>
          {PERIODS.map(([h, label]) => (
            <option key={h} value={h}>
              {label}
            </option>
          ))}
        </select>
        {result && <span className="note">Fuente: {result.source}</span>}
        <div style={{ flex: 1 }} />
        <button className="icon" title="Actualizar" disabled={loading} onClick={() => void reload()}>
          <Icon name="refresh" />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="section-label">Intentos fallidos por IP ({failures.reduce((s, f) => s + f.attempts, 0)})</div>
      <FailuresTable failures={failures} banButton={banButton} empty={loading ? 'Cargando…' : 'Ningún intento fallido en este periodo.'} />
      <div className="section-label" style={{ marginTop: 16 }}>
        Accesos correctos ({accepted.length})
      </div>
      {accepted.length ? (
        <table className="result-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Usuario</th>
              <th>IP</th>
              <th>Método</th>
            </tr>
          </thead>
          <tbody>
            {accepted.slice(0, 200).map((e, i) => (
              <tr key={i}>
                <td className="note">{e.time}</td>
                <td>{e.user}</td>
                <td className="mono" title={ipKind(e.ip)}>
                  {e.ip}
                </td>
                <td>{e.method}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-note">{loading ? 'Cargando…' : 'Ningún acceso en este periodo.'}</div>
      )}
    </>
  )
}

function SessionsTab({ call }: { call: Call }) {
  const { data, error, loading, reload } = useData(useCallback(() => call('security.sessions', {}), [call]))
  const sessions = data as SessionsResult | null
  return (
    <>
      <div className="service-actions">
        <div className="section-label" style={{ margin: 0 }}>
          Conectados ahora
        </div>
        <div style={{ flex: 1 }} />
        <button className="icon" title="Actualizar" disabled={loading} onClick={() => void reload()}>
          <Icon name="refresh" />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {sessions?.who.length ? (
        <table className="result-table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Terminal</th>
              <th>Desde</th>
              <th>Origen</th>
            </tr>
          </thead>
          <tbody>
            {sessions.who.map((w, i) => (
              <tr key={i}>
                <td>{w.user}</td>
                <td className="mono">{w.tty}</td>
                <td className="note">{w.since}</td>
                <td className="mono">{w.from}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-note">{loading ? 'Cargando…' : 'Nadie conectado con sesión interactiva.'}</div>
      )}
      <div className="section-label" style={{ marginTop: 16 }}>
        Últimos accesos (last)
      </div>
      <pre className="log-text static">{sessions?.last || (loading ? 'Cargando…' : 'Sin datos (el servidor no tiene «last» o no hay registro wtmp).')}</pre>
    </>
  )
}

function Fail2banTab({
  data,
  error,
  loading,
  onUnban,
  onBan
}: {
  data: Fail2banResult | null
  error: string | null
  loading: boolean
  onUnban: (ip: string, jail: string) => void
  onBan: (ip: string, jail: string) => void
}) {
  const [manual, setManual] = useState<Record<string, string>>({})
  if (error) return <div className="notice error">{error}</div>
  if (!data) return <div className="empty-note">{loading ? 'Consultando fail2ban…' : ''}</div>
  if (!data.installed)
    return (
      <div className="empty-note">
        fail2ban no está instalado en este servidor. Bloquea automáticamente las IPs que fallan repetidamente al entrar por SSH (y otros servicios);
        se instala con el gestor de paquetes (<code>apt install fail2ban</code>, <code>dnf install fail2ban</code>…).
      </div>
    )
  if (data.error) return <div className="notice error">fail2ban está instalado pero no responde: {data.error}</div>
  if (!data.jails.length) return <div className="empty-note">fail2ban no tiene ninguna jail activa.</div>
  return (
    <div className="jails">
      {data.jails.map((jail) => (
        <div className="jail-card" key={jail.name}>
          <div className="service-head">
            <strong className="service-name">{jail.name}</strong>
            <span className="note">
              Fallos ahora {jail.currentlyFailed} · total {jail.totalFailed} · bloqueadas ahora {jail.currentlyBanned} · total {jail.totalBanned}
            </span>
          </div>
          {jail.bannedIps.length ? (
            <table className="result-table">
              <tbody>
                {jail.bannedIps.map((ip) => (
                  <tr key={ip}>
                    <td className="mono">{ip}</td>
                    <td className="note">{ipKind(ip)}</td>
                    <td className="row-action">
                      <button onClick={() => onUnban(ip, jail.name)}>Desbloquear</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-note">Ninguna IP bloqueada.</div>
          )}
          <form
            className="service-actions"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault()
              const ip = (manual[jail.name] ?? '').trim()
              if (ip) onBan(ip, jail.name)
            }}
          >
            <input
              placeholder="IP a bloquear a mano"
              style={{ width: 220 }}
              value={manual[jail.name] ?? ''}
              onChange={(e) => setManual((m) => ({ ...m, [jail.name]: e.target.value }))}
            />
            <button type="submit" className="danger" disabled={!(manual[jail.name] ?? '').trim()}>
              Bloquear
            </button>
          </form>
        </div>
      ))}
    </div>
  )
}

function FirewallTab({ call }: { call: Call }) {
  const { data, error, loading, reload } = useData(useCallback(() => call('security.firewall', {}), [call]))
  const result = data as FirewallResult | null
  const names = { ufw: 'UFW', firewalld: 'firewalld', nftables: 'nftables', iptables: 'iptables' }
  return (
    <>
      <div className="service-actions">
        {result &&
          (result.tool ? (
            <>
              <strong>{names[result.tool]}</strong>
              {result.active !== null && <span className={`state-pill ${result.active ? 'ok' : 'error'}`}>{result.active ? 'activo' : 'inactivo'}</span>}
            </>
          ) : (
            <span className="state-pill error">No se encontró ningún cortafuegos</span>
          ))}
        <span className="note">Solo lectura: los cambios de reglas, mejor desde el terminal (un error puede dejarte sin acceso).</span>
        <div style={{ flex: 1 }} />
        <button className="icon" title="Actualizar" disabled={loading} onClick={() => void reload()}>
          <Icon name="refresh" />
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      <pre className="log-text static" style={{ maxHeight: 'none' }}>
        {result ? result.text || '(sin reglas)' : loading ? 'Cargando…' : ''}
      </pre>
    </>
  )
}
