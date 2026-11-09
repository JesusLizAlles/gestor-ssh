import { useCallback, useEffect, useMemo, useState } from 'react'
import { basename } from '@shared/remote-path'
import { cdCommand } from '@shared/shell'
import type { HostKeyRequest, SecretStorageStatus, ServerSummary, TransferInfo } from '@shared/types'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ContextMenu, type MenuItem } from './components/ContextMenu'
import { EditorView } from './components/EditorView'
import { FileBrowser } from './components/FileBrowser'
import { HostKeyDialog } from './components/HostKeyDialog'
import { Icon, type IconName } from './components/Icon'
import { ServerDialog } from './components/ServerDialog'
import { TerminalView } from './components/TerminalView'
import { TransfersPanel } from './components/TransfersPanel'
import { ApacheView } from './components/modules/ApacheView'
import { MysqlView } from './components/modules/MysqlView'
import { ServicesView } from './components/modules/ServicesView'
import { moduleInfo, type ModuleId } from '@shared/modules'

type ConnState =
  | { state: 'connecting' }
  | { state: 'connected'; home: string; fingerprint: string }
  | { state: 'error'; error: string; home?: string; fingerprint?: string }

interface BaseTab {
  id: string
  serverId: string
}
type Tab =
  | (BaseTab & { kind: 'files'; startPath: string; path: string; epoch: number })
  | (BaseTab & { kind: 'terminal'; initialCommand?: string; title: string | null })
  | (BaseTab & { kind: 'editor'; path: string; dirty: boolean })
  | (BaseTab & { kind: 'module'; moduleId: ModuleId })

type Dialog =
  | { kind: 'server'; initial: ServerSummary | null }
  | { kind: 'deleteServer'; server: ServerSummary }
  | { kind: 'closeTabs'; tabIds: string[]; then?: () => void }

const ENV_LABEL = { dev: 'DEV', test: 'TEST', prod: 'PROD' } as const
const MODULE_ICONS: Record<ModuleId, IconName> = { services: 'gear', apache: 'globe', mysql: 'database' }

export function App() {
  const [servers, setServers] = useState<ServerSummary[]>([])
  const [secretStatus, setSecretStatus] = useState<SecretStorageStatus | null>(null)
  const [conns, setConns] = useState<Record<string, ConnState>>({})
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [hostKeys, setHostKeys] = useState<HostKeyRequest[]>([])
  const [transfers, setTransfers] = useState<Map<string, TransferInfo>>(new Map())
  const [showTransfers, setShowTransfers] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void window.api.listServers().then(setServers)
    void window.api.secretStorageStatus().then(setSecretStatus)
    void window.api.listTransfers().then((list) => setTransfers(new Map(list.map((t) => [t.id, t]))))
    const offHostKey = window.api.onHostKey((request) => setHostKeys((q) => [...q, request]))
    const offTransfer = window.api.onTransfer((t) => {
      // Una transferencia nueva abre el panel para que se vea el progreso.
      if (t.state === 'queued') setShowTransfers(true)
      setTransfers((current) => new Map(current).set(t.id, t))
    })
    const offSession = window.api.onSession((event) => {
      setConns((c) => {
        const previous = c[event.serverId]
        const kept = previous && previous.state === 'connected' ? { home: previous.home, fingerprint: previous.fingerprint } : {}
        return { ...c, [event.serverId]: { state: 'error', error: event.reason, ...kept } }
      })
    })
    return () => {
      offHostKey()
      offTransfer()
      offSession()
    }
  }, [])

  const serverById = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers])
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const activeServer = activeTab ? serverById.get(activeTab.serverId) : selectedServerId ? serverById.get(selectedServerId) : undefined

  const addTab = (tab: Tab) => {
    setTabs((t) => [...t, tab])
    setActiveTabId(tab.id)
  }

  /** Conecta (si hace falta) y devuelve la carpeta personal; null si no se pudo. */
  const ensureConnected = useCallback(
    async (server: ServerSummary): Promise<string | null> => {
      const current = conns[server.id]
      if (current?.state === 'connected') return current.home
      setConns((c) => ({ ...c, [server.id]: { state: 'connecting' } }))
      try {
        const result = await window.api.connect(server.id)
        setConns((c) => ({ ...c, [server.id]: { state: 'connected', home: result.home, fingerprint: result.fingerprint } }))
        // Las pestañas que se quedaron sin conexión vuelven a cargar donde estaban.
        setTabs((list) => list.map((t) => (t.serverId === server.id && t.kind === 'files' ? { ...t, startPath: t.path, epoch: t.epoch + 1 } : t)))
        return result.home
      } catch (err) {
        setConns((c) => ({ ...c, [server.id]: { state: 'error', error: (err as Error).message } }))
        return null
      }
    },
    [conns]
  )

  const openFiles = async (server: ServerSummary) => {
    setSelectedServerId(server.id)
    const existing = tabs.find((t) => t.serverId === server.id && t.kind === 'files')
    const home = await ensureConnected(server)
    if (home === null) return
    if (existing) return setActiveTabId(existing.id)
    const start = server.initialPath.trim() || home
    addTab({ id: crypto.randomUUID(), serverId: server.id, kind: 'files', startPath: start, path: start, epoch: 0 })
  }

  const openTerminal = async (server: ServerSummary, cwd?: string) => {
    setSelectedServerId(server.id)
    if ((await ensureConnected(server)) === null) return
    addTab({ id: crypto.randomUUID(), serverId: server.id, kind: 'terminal', initialCommand: cwd ? cdCommand(cwd) : undefined, title: null })
  }

  const openModule = async (server: ServerSummary, moduleId: ModuleId) => {
    setSelectedServerId(server.id)
    const existing = tabs.find((t) => t.kind === 'module' && t.serverId === server.id && t.moduleId === moduleId)
    if ((await ensureConnected(server)) === null) return
    if (existing) return setActiveTabId(existing.id)
    addTab({ id: crypto.randomUUID(), serverId: server.id, kind: 'module', moduleId })
  }

  const openEditor = (serverId: string, path: string) => {
    const existing = tabs.find((t) => t.kind === 'editor' && t.serverId === serverId && t.path === path)
    if (existing) return setActiveTabId(existing.id)
    addTab({ id: crypto.randomUUID(), serverId, kind: 'editor', path, dirty: false })
  }

  const removeTabs = (ids: string[]) => {
    const remove = new Set(ids)
    setTabs((list) => {
      const next = list.filter((t) => !remove.has(t.id))
      if (activeTabId && remove.has(activeTabId)) {
        const index = list.findIndex((t) => t.id === activeTabId)
        const fallback = next[Math.min(index, next.length - 1)]
        setActiveTabId(fallback?.id ?? null)
      }
      return next
    })
  }

  /** Cierra pestañas; si alguna tiene cambios sin guardar, pregunta antes. */
  const closeTabs = (ids: string[], then?: () => void) => {
    const dirty = tabs.some((t) => ids.includes(t.id) && t.kind === 'editor' && t.dirty)
    if (dirty) return setDialog({ kind: 'closeTabs', tabIds: ids, then })
    removeTabs(ids)
    then?.()
  }

  const disconnect = (server: ServerSummary) => {
    const ids = tabs.filter((t) => t.serverId === server.id).map((t) => t.id)
    closeTabs(ids, () => {
      void window.api.disconnect(server.id)
      setConns((c) => {
        const next = { ...c }
        delete next[server.id]
        return next
      })
    })
  }

  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((list) => list.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)))
  }, [])

  const serverMenu = (server: ServerSummary, x: number, y: number) => {
    const connected = conns[server.id]?.state === 'connected'
    const items: MenuItem[] = [
      { label: 'Abrir ficheros', onSelect: () => void openFiles(server) },
      { label: 'Abrir terminal', onSelect: () => void openTerminal(server) },
      ...server.modules.map((id) => ({ label: `Abrir ${moduleInfo(id).name}`, onSelect: () => void openModule(server, id) })),
      connected
        ? { label: 'Desconectar', onSelect: () => disconnect(server) }
        : { label: 'Conectar', onSelect: () => void ensureConnected(server) },
      { label: 'Editar…', onSelect: () => setDialog({ kind: 'server', initial: server }) },
      {
        label: 'Duplicar…',
        onSelect: () => {
          const { id: _id, storedSecrets: _s, ...rest } = server
          setDialog({ kind: 'server', initial: { ...rest, id: '', name: `${server.name} (copia)`, storedSecrets: [] } as ServerSummary })
        }
      },
      {
        label: 'Copiar usuario@servidor',
        onSelect: async () => {
          await navigator.clipboard.writeText(`${server.username}@${server.host}${server.port !== 22 ? ` -p ${server.port}` : ''}`)
          return 'Copiado'
        }
      },
      { label: 'Eliminar…', onSelect: () => setDialog({ kind: 'deleteServer', server }) }
    ]
    setMenu({ x, y, items })
  }

  const visibleServers = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return servers
      .filter((s) => !needle || `${s.name} ${s.host} ${s.username}`.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
  }, [servers, filter])

  const transferList = [...transfers.values()]
  const activeTransfers = transferList.filter((t) => t.state === 'running' || t.state === 'queued').length

  const tabTitle = (tab: Tab): string => {
    if (tab.kind === 'files') return basename(tab.path)
    if (tab.kind === 'editor') return basename(tab.path)
    if (tab.kind === 'module') return moduleInfo(tab.moduleId).name
    return tab.title ?? serverById.get(tab.serverId)?.name ?? 'Terminal'
  }

  const activeConn = activeServer ? conns[activeServer.id] : undefined
  const pendingHostKey = hostKeys[0]

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="section-title">
          <span>Servidores</span>
          <div className="section-actions">
            <button className="icon" title="Nuevo servidor" onClick={() => setDialog({ kind: 'server', initial: null })}>
              <Icon name="plus" />
            </button>
          </div>
        </div>
        {servers.length > 6 && (
          <div className="sidebar-filter">
            <input placeholder="Buscar servidor…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
        <div className="servers">
          {!servers.length && (
            <div className="empty-note">
              Aún no hay servidores.{' '}
              <button className="link" onClick={() => setDialog({ kind: 'server', initial: null })}>
                Añade el primero
              </button>
              .
            </div>
          )}
          {visibleServers.map((server) => {
            const conn = conns[server.id]
            return (
              <div key={server.id}>
                <div
                  className={`server ${selectedServerId === server.id ? 'selected' : ''}`}
                  title={`${server.username}@${server.host}:${server.port}`}
                  onClick={() => setSelectedServerId(server.id)}
                  onDoubleClick={() => void openFiles(server)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setSelectedServerId(server.id)
                    serverMenu(server, e.clientX, e.clientY)
                  }}
                >
                  {conn?.state === 'connecting' ? <div className="spinner" /> : <span className={`state-dot ${conn?.state === 'connected' ? 'connected' : conn?.state === 'error' ? 'error' : ''}`} />}
                  <span className="name">{server.name}</span>
                  {server.environment !== 'dev' && <span className={`badge ${server.environment}`}>{ENV_LABEL[server.environment]}</span>}
                  <span className="host">{server.host}</span>
                  <div className="actions">
                    <button className="icon" title="Ficheros" onClick={(e) => (e.stopPropagation(), void openFiles(server))}>
                      <Icon name="folder" />
                    </button>
                    <button className="icon" title="Terminal" onClick={(e) => (e.stopPropagation(), void openTerminal(server))}>
                      <Icon name="terminal" />
                    </button>
                    <button className="icon" title="Editar" onClick={(e) => (e.stopPropagation(), setDialog({ kind: 'server', initial: server }))}>
                      <Icon name="edit" />
                    </button>
                  </div>
                </div>
                {server.modules.length > 0 && (conn?.state === 'connected' || selectedServerId === server.id) && (
                  <div className="server-modules">
                    {server.modules.map((id) => (
                      <div
                        key={id}
                        className={`module-row ${activeTab?.kind === 'module' && activeTab.serverId === server.id && activeTab.moduleId === id ? 'active' : ''}`}
                        onClick={() => void openModule(server, id)}
                        title={moduleInfo(id).description}
                      >
                        <Icon name={MODULE_ICONS[id]} />
                        <span>{moduleInfo(id).name}</span>
                      </div>
                    ))}
                  </div>
                )}
                {conn?.state === 'error' && (
                  <div className="notice error" style={{ margin: '2px 8px 6px', padding: '5px 8px' }}>
                    {conn.error}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      <main className="app-main">
        {tabs.length > 0 && (
          <div className="tabs">
            {tabs.map((tab) => {
              const server = serverById.get(tab.serverId)
              return (
                <div
                  key={tab.id}
                  className={`tab ${tab.id === activeTabId ? 'active' : ''} ${server?.environment === 'prod' ? 'prod' : ''}`}
                  onClick={() => setActiveTabId(tab.id)}
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault()
                      closeTabs([tab.id])
                    }
                  }}
                  title={tab.kind === 'terminal' ? (tab.title ?? '') : tab.kind === 'module' ? moduleInfo(tab.moduleId).description : tab.path}
                >
                  <Icon name={tab.kind === 'files' ? 'folder' : tab.kind === 'terminal' ? 'terminal' : tab.kind === 'module' ? MODULE_ICONS[tab.moduleId] : 'file'} />
                  <span className="title">{tabTitle(tab)}</span>
                  {tab.kind === 'editor' && tab.dirty && <span className="dirty">●</span>}
                  <span className="server-tag">{server?.name}</span>
                  <button
                    className="icon"
                    title="Cerrar"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTabs([tab.id])
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {!tabs.length && (
          <div className="welcome">
            <h1>Gestor SSH</h1>
            <div>
              {servers.length
                ? 'Haz doble clic en un servidor para ver sus ficheros, o usa el botón de terminal.'
                : 'Añade un servidor con el botón + del panel izquierdo.'}
            </div>
            <div className="note">
              En el terminal: copiar <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> · pegar <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>
            </div>
          </div>
        )}
        {tabs.map((tab) => {
          const server = serverById.get(tab.serverId)
          const conn = conns[tab.serverId]
          if (!server) return null
          const connected = conn?.state === 'connected'
          const active = tab.id === activeTabId
          return (
            <div key={tab.id} className={`tab-body ${active ? '' : 'hidden'}`}>
              {!connected && tab.kind !== 'terminal' && tab.kind !== 'module' && (
                <div className="notice warn" style={{ margin: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ flex: 1 }}>{conn?.state === 'connecting' ? 'Conectando…' : `Sin conexión con ${server.name}.`}</span>
                  {conn?.state !== 'connecting' && (
                    <button onClick={() => void ensureConnected(server)}>
                      <Icon name="connect" /> Reconectar
                    </button>
                  )}
                </div>
              )}
              {tab.kind === 'files' && (
                <FileBrowser
                  key={tab.epoch}
                  server={server}
                  startPath={tab.startPath}
                  home={conn && 'home' in conn && conn.home ? conn.home : tab.startPath}
                  active={active}
                  onOpenFile={(path) => openEditor(server.id, path)}
                  onOpenTerminal={(cwd) => void openTerminal(server, cwd)}
                  onPathChange={(path) => {
                    if (path !== tab.path) updateTab(tab.id, { path })
                  }}
                />
              )}
              {tab.kind === 'terminal' && (
                <TerminalView
                  serverId={server.id}
                  connected={connected}
                  active={active}
                  initialCommand={tab.initialCommand}
                  onTitle={(title) => updateTab(tab.id, { title: title || null })}
                />
              )}
              {tab.kind === 'module' &&
                (connected ? (
                  <div className="module-host" key={conn.fingerprint + String(tab.moduleId)}>
                    {tab.moduleId === 'services' && <ServicesView server={server} onOpenFile={(path) => openEditor(server.id, path)} />}
                    {tab.moduleId === 'apache' && <ApacheView server={server} onOpenFile={(path) => openEditor(server.id, path)} />}
                    {tab.moduleId === 'mysql' && <MysqlView server={server} onOpenFile={(path) => openEditor(server.id, path)} />}
                  </div>
                ) : (
                  <div className="notice warn" style={{ margin: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ flex: 1 }}>{conn?.state === 'connecting' ? 'Conectando…' : `Sin conexión con ${server.name}.`}</span>
                    {conn?.state !== 'connecting' && (
                      <button onClick={() => void ensureConnected(server)}>
                        <Icon name="connect" /> Reconectar
                      </button>
                    )}
                  </div>
                ))}
              {tab.kind === 'editor' && (
                <EditorView
                  server={server}
                  path={tab.path}
                  active={active}
                  connected={connected}
                  onDirty={(dirty) => {
                    if (dirty !== tab.dirty) updateTab(tab.id, { dirty })
                  }}
                />
              )}
            </div>
          )
        })}
      </main>

      {showTransfers && (
        <TransfersPanel
          transfers={transferList}
          onClose={() => setShowTransfers(false)}
          onClear={() => {
            void window.api.clearTransfers().then(async () => {
              const list = await window.api.listTransfers()
              setTransfers(new Map(list.map((t) => [t.id, t])))
            })
          }}
        />
      )}

      <footer className="statusbar">
        {activeServer ? (
          <>
            <span>
              {activeServer.username}@{activeServer.host}
              {activeServer.port !== 22 ? `:${activeServer.port}` : ''}
            </span>
            {activeConn?.state === 'connected' && <span className="mono" title="Huella del servidor">{activeConn.fingerprint}</span>}
          </>
        ) : (
          <span>{servers.length} servidores</span>
        )}
        {secretStatus && !secretStatus.persistent && <span style={{ color: 'var(--warn)' }}>Sin llavero: las contraseñas no se guardan en disco</span>}
        <div className="spacer" />
        <button className="status-btn" onClick={() => setShowTransfers((v) => !v)}>
          <Icon name="transfer" /> Transferencias{activeTransfers ? ` (${activeTransfers} en curso)` : ''}
        </button>
      </footer>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'server' && (
        <ServerDialog
          initial={dialog.initial?.id ? dialog.initial : null}
          template={dialog.initial && !dialog.initial.id ? dialog.initial : null}
          secretStatus={secretStatus}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setServers((list) => (list.some((s) => s.id === saved.id) ? list.map((s) => (s.id === saved.id ? saved : s)) : [...list, saved]))
            setSelectedServerId(saved.id)
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'deleteServer' && (
        <ConfirmDialog
          title={`Eliminar ${dialog.server.name}`}
          confirmLabel="Eliminar"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            const server = dialog.server
            setDialog(null)
            closeTabs(
              tabs.filter((t) => t.serverId === server.id).map((t) => t.id),
              () => {
                void window.api.deleteServer(server.id).then(() => {
                  setServers((list) => list.filter((s) => s.id !== server.id))
                  setConns((c) => {
                    const next = { ...c }
                    delete next[server.id]
                    return next
                  })
                })
              }
            )
          }}
        >
          Se borrará el servidor y sus contraseñas guardadas. En el servidor no se toca nada.
        </ConfirmDialog>
      )}
      {dialog?.kind === 'closeTabs' && (
        <ConfirmDialog
          title="Cambios sin guardar"
          confirmLabel="Cerrar sin guardar"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            removeTabs(dialog.tabIds)
            dialog.then?.()
            setDialog(null)
          }}
        >
          Hay ficheros con cambios sin guardar. Si cierras, se perderán.
        </ConfirmDialog>
      )}
      {pendingHostKey && (
        <HostKeyDialog
          key={pendingHostKey.requestId}
          request={pendingHostKey}
          onAnswer={(accept) => {
            void window.api.respondHostKey(pendingHostKey.requestId, accept)
            setHostKeys((q) => q.slice(1))
          }}
        />
      )}
    </div>
  )
}
