import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { formatDate, formatMode, formatOctal, formatSize } from '@shared/format'
import { breadcrumbs, isValidName, join, parent } from '@shared/remote-path'
import { MAX_EDIT_BYTES, type RemoteEntry, type ServerSummary, type UploadPlan } from '@shared/types'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { PromptDialog } from './PromptDialog'

interface Props {
  server: ServerSummary
  /** Carpeta en la que se abre. */
  startPath: string
  home: string
  active: boolean
  onOpenFile: (path: string) => void
  onOpenTerminal: (cwd: string) => void
  /** Avisa de la carpeta actual (para el título de la pestaña). */
  onPathChange: (path: string) => void
}

type SortKey = 'name' | 'size' | 'mtime'
type Dialog =
  | { kind: 'mkdir' }
  | { kind: 'touch' }
  | { kind: 'rename'; entry: RemoteEntry }
  | { kind: 'delete'; entries: RemoteEntry[] }
  | { kind: 'conflicts'; plan: UploadPlan }

const isDirLike = (e: RemoteEntry) => e.type === 'dir' || (e.type === 'link' && e.linkTarget === 'dir')
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' })

/** Explorador de ficheros del servidor (SFTP). */
export function FileBrowser({ server, startPath, home, active, onOpenFile, onOpenTerminal, onPathChange }: Props) {
  const [path, setPath] = useState(startPath)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(true)
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  const load = useCallback(
    async (target: string, opts: { keepSelection?: boolean; pushHistory?: boolean } = {}) => {
      setLoading(true)
      try {
        const listing = await window.api.listDir(server.id, target)
        if (opts.pushHistory && listing.path !== pathRef.current) setHistory((h) => [...h.slice(-49), pathRef.current])
        setEntries(listing.entries)
        setError(null)
        if (listing.path !== pathRef.current) {
          setPath(listing.path)
          setFilter('')
          scrollRef.current?.scrollTo({ top: 0 })
        }
        if (!opts.keepSelection) {
          setSelected(new Set())
          setAnchor(null)
        } else {
          const existing = new Set(listing.entries.map((e) => e.path))
          setSelected((s) => new Set([...s].filter((p) => existing.has(p))))
        }
      } catch (err) {
        // Si falla al entrar en otra carpeta, se queda donde estaba y enseña el error.
        if (target === pathRef.current) {
          setEntries([])
          setError((err as Error).message)
        } else setNotice((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [server.id]
  )

  useEffect(() => {
    void load(startPath)
  }, [load, startPath])

  useEffect(() => onPathChange(path), [path, onPathChange])

  useEffect(() => {
    if (active) requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }))
  }, [active])

  const refresh = useCallback(() => void load(pathRef.current, { keepSelection: true }), [load])

  // Cuando termina una subida a esta carpeta, se vuelve a listar.
  useEffect(
    () =>
      window.api.onTransfer((t) => {
        if (t.direction === 'upload' && t.serverId === server.id && t.state === 'done' && t.destination === pathRef.current) refresh()
      }),
    [server.id, refresh]
  )

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const list = entries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!needle || e.name.toLowerCase().includes(needle)))
    const dir = sort.asc ? 1 : -1
    return list.sort((a, b) => {
      if (isDirLike(a) !== isDirLike(b)) return isDirLike(a) ? -1 : 1
      if (sort.key === 'size' && a.size !== b.size) return (a.size - b.size) * dir
      if (sort.key === 'mtime' && a.mtime !== b.mtime) return (a.mtime - b.mtime) * dir
      return collator.compare(a.name, b.name) * (sort.key === 'name' ? dir : 1)
    })
  }, [entries, filter, showHidden, sort])

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12
  })

  const selectedEntries = visible.filter((e) => selected.has(e.path))

  const navigate = (target: string) => void load(target, { pushHistory: true })
  const goBack = () => {
    const previous = history[history.length - 1]
    if (!previous) return
    setHistory((h) => h.slice(0, -1))
    void load(previous)
  }

  const open = (entry: RemoteEntry) => {
    if (isDirLike(entry)) return navigate(entry.path)
    if (entry.type === 'link' && !entry.linkTarget) return setNotice(`El enlace ${entry.name} está roto o no se puede seguir`)
    if (entry.type === 'other') return setNotice(`${entry.name} no es un fichero normal`)
    if (entry.size > MAX_EDIT_BYTES) return void download([entry])
    onOpenFile(entry.path)
  }

  const download = async (list: RemoteEntry[]) => {
    if (!list.length) return
    try {
      await window.api.download(server.id, list.map((e) => e.path))
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  const upload = async (kind: 'files' | 'folder') => {
    try {
      const plan = await window.api.planUpload(server.id, path, kind)
      if (!plan) return
      if (plan.conflicts.length) setDialog({ kind: 'conflicts', plan })
      else await window.api.startUpload(plan.token, 'overwrite')
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  const select = (index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const entry = visible[index]
    if (!entry) return
    if (e.shiftKey && anchor !== null) {
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor]
      setSelected(new Set(visible.slice(from, to + 1).map((v) => v.path)))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      })
    } else setSelected(new Set([entry.path]))
    setAnchor(index)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (dialog || menu) return
    const index = anchor ?? -1
    const move = (to: number) => {
      const next = Math.max(0, Math.min(visible.length - 1, to))
      const entry = visible[next]
      if (!entry) return
      if (e.shiftKey && anchor !== null) {
        const [from, end] = anchor < next ? [anchor, next] : [next, anchor]
        setSelected(new Set(visible.slice(from, end + 1).map((v) => v.path)))
      } else {
        setSelected(new Set([entry.path]))
        setAnchor(next)
      }
      virtualizer.scrollToIndex(next)
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(index + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        move(index - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(visible.length - 1)
        break
      case 'Enter':
        if (selectedEntries.length === 1) open(selectedEntries[0]!)
        break
      case 'Backspace':
        if (path !== '/') navigate(parent(path))
        break
      case 'Delete':
        if (selectedEntries.length) setDialog({ kind: 'delete', entries: selectedEntries })
        break
      case 'F2':
        if (selectedEntries.length === 1) setDialog({ kind: 'rename', entry: selectedEntries[0]! })
        break
      case 'F5':
        refresh()
        break
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          setSelected(new Set(visible.map((v) => v.path)))
        }
        break
    }
  }

  const rowMenu = (entry: RemoteEntry, x: number, y: number) => {
    const targets = selected.has(entry.path) ? selectedEntries : [entry]
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]))
    const single = targets.length === 1
    const items: MenuItem[] = []
    if (single) {
      items.push({ label: isDirLike(entry) ? 'Abrir' : 'Editar', onSelect: () => open(entry) })
    }
    items.push({ label: targets.length > 1 ? `Descargar ${targets.length} elementos…` : 'Descargar…', onSelect: () => void download(targets) })
    if (single) items.push({ label: 'Renombrar…', onSelect: () => setDialog({ kind: 'rename', entry }) })
    items.push({ label: targets.length > 1 ? `Eliminar ${targets.length} elementos…` : 'Eliminar…', onSelect: () => setDialog({ kind: 'delete', entries: targets }) })
    if (single) {
      items.push({
        label: 'Copiar ruta',
        onSelect: async () => {
          await navigator.clipboard.writeText(entry.path)
          return 'Copiada'
        }
      })
      if (isDirLike(entry)) items.push({ label: 'Abrir terminal aquí', onSelect: () => onOpenTerminal(entry.path) })
    }
    setMenu({ x, y, items })
  }

  const backgroundMenu = (x: number, y: number) => {
    setSelected(new Set())
    setMenu({
      x,
      y,
      items: [
        { label: 'Nueva carpeta…', onSelect: () => setDialog({ kind: 'mkdir' }) },
        { label: 'Nuevo fichero…', onSelect: () => setDialog({ kind: 'touch' }) },
        { label: 'Subir ficheros…', onSelect: () => void upload('files') },
        { label: 'Subir carpeta…', onSelect: () => void upload('folder') },
        { label: 'Abrir terminal aquí', onSelect: () => onOpenTerminal(path) },
        {
          label: 'Copiar ruta de la carpeta',
          onSelect: async () => {
            await navigator.clipboard.writeText(path)
            return 'Copiada'
          }
        },
        { label: 'Actualizar', onSelect: refresh }
      ]
    })
  }

  const nameProblem = (name: string, current?: string) => {
    const trimmed = name.trim()
    if (!isValidName(trimmed)) return 'Nombre no válido: sin «/» y distinto de «.» y «..»'
    if (trimmed !== current && entries.some((e) => e.name === trimmed)) return `Ya existe «${trimmed}» en esta carpeta`
    return null
  }

  const sortHeader = (key: SortKey, label: string, className?: string) => (
    <span className={className} onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}>
      {label}
      {sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : ''}
    </span>
  )

  const fileIcon = (e: RemoteEntry) => {
    if (isDirLike(e)) return <Icon name="folder" className="ficon-dir" />
    if (e.type === 'link') return <Icon name="link" className="ficon-link" />
    return <Icon name="file" className="ficon-file" />
  }

  return (
    <>
      <div className="toolbar">
        <button className="icon" title="Atrás" disabled={!history.length} onClick={goBack}>
          <Icon name="back" />
        </button>
        <button className="icon" title="Carpeta superior (Retroceso)" disabled={path === '/'} onClick={() => navigate(parent(path))}>
          <Icon name="up" />
        </button>
        <button className="icon" title={`Carpeta personal (${home})`} onClick={() => navigate(home)}>
          <Icon name="home" />
        </button>
        <button className="icon" title="Actualizar (F5)" onClick={refresh}>
          <Icon name="refresh" />
        </button>
        <div className="pathbar" onClick={() => editingPath === null && setEditingPath(path)}>
          {editingPath !== null ? (
            <input
              autoFocus
              value={editingPath}
              spellCheck={false}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setEditingPath(e.target.value)}
              onBlur={() => setEditingPath(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  navigate(editingPath)
                  setEditingPath(null)
                  listRef.current?.focus()
                } else if (e.key === 'Escape') setEditingPath(null)
              }}
            />
          ) : (
            <div className="crumbs">
              {breadcrumbs(path).map((crumb, i) => (
                <span key={crumb.path} style={{ display: 'contents' }}>
                  {i > 1 && <span className="crumb-sep">/</span>}
                  <span
                    className="crumb"
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate(crumb.path)
                    }}
                  >
                    {crumb.name}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
        <input className="filter" placeholder="Filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className={`icon ${showHidden ? 'on' : ''}`} title={showHidden ? 'Ocultar ficheros ocultos' : 'Mostrar ficheros ocultos'} onClick={() => setShowHidden((v) => !v)}>
          <Icon name="eye" />
        </button>
        <div className="sep" />
        <button className="icon" title="Nueva carpeta" onClick={() => setDialog({ kind: 'mkdir' })}>
          <Icon name="folderPlus" />
        </button>
        <button className="icon" title="Nuevo fichero" onClick={() => setDialog({ kind: 'touch' })}>
          <Icon name="filePlus" />
        </button>
        <button className="icon" title="Subir ficheros a esta carpeta" onClick={() => void upload('files')}>
          <Icon name="upload" />
        </button>
        <button className="icon" title="Descargar lo seleccionado" disabled={!selectedEntries.length} onClick={() => void download(selectedEntries)}>
          <Icon name="download" />
        </button>
        <button className="icon" title="Abrir un terminal en esta carpeta" onClick={() => onOpenTerminal(path)}>
          <Icon name="terminal" />
        </button>
      </div>

      {notice && (
        <div className="notice error" style={{ margin: '8px 8px 0' }} onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      <div
        className="files"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault()
          backgroundMenu(e.clientX, e.clientY)
        }}
      >
        <div className="files-head">
          {sortHeader('name', 'Nombre')}
          {sortHeader('size', 'Tamaño', 'num')}
          {sortHeader('mtime', 'Modificado')}
          <span>Permisos</span>
          <span>Propietario</span>
        </div>
        {loading && <div className="spinner files-loading" />}
        {error ? (
          <div className="files-error">{error}</div>
        ) : !visible.length && !loading ? (
          <div className="files-empty">{entries.length ? 'Nada coincide con el filtro.' : 'Carpeta vacía.'}</div>
        ) : null}
        <div
          className="files-scroll"
          ref={scrollRef}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelected(new Set())
          }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const entry = visible[row.index]!
              return (
                <div
                  key={entry.path}
                  className={`file-row ${selected.has(entry.path) ? 'selected' : ''} ${entry.name.startsWith('.') ? 'hidden-file' : ''}`}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }}
                  onMouseDown={(e) => {
                    if (e.button === 0) select(row.index, e)
                  }}
                  onDoubleClick={() => open(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    rowMenu(entry, e.clientX, e.clientY)
                  }}
                  title={entry.type === 'link' ? `${entry.name} (enlace${entry.linkTarget ? '' : ' roto'})` : entry.name}
                >
                  <div className="fname">
                    {fileIcon(entry)}
                    <span>{entry.name}</span>
                  </div>
                  <div className="meta num">{isDirLike(entry) ? '' : formatSize(entry.size)}</div>
                  <div className="meta">{formatDate(entry.mtime)}</div>
                  <div className="meta perm" title={formatOctal(entry.mode)}>
                    {formatMode(entry.mode, entry.type)}
                  </div>
                  <div className="meta" title={`${entry.owner}:${entry.group} (${entry.uid}:${entry.gid})`}>
                    {entry.owner}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'mkdir' && (
        <PromptDialog
          title="Nueva carpeta"
          label={`Dentro de ${path}`}
          confirmLabel="Crear"
          validate={(v) => nameProblem(v)}
          onCancel={() => setDialog(null)}
          onConfirm={async (name) => {
            const target = join(path, name.trim())
            await window.api.makeDir(server.id, target)
            setDialog(null)
            await load(path)
            setSelected(new Set([target]))
          }}
        />
      )}
      {dialog?.kind === 'touch' && (
        <PromptDialog
          title="Nuevo fichero"
          label={`Dentro de ${path}`}
          confirmLabel="Crear y editar"
          validate={(v) => nameProblem(v)}
          onCancel={() => setDialog(null)}
          onConfirm={async (name) => {
            const target = join(path, name.trim())
            await window.api.createFile(server.id, target)
            setDialog(null)
            await load(path)
            onOpenFile(target)
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <PromptDialog
          title="Renombrar"
          label={`Nuevo nombre para ${dialog.entry.name}`}
          initial={dialog.entry.name}
          confirmLabel="Renombrar"
          validate={(v) => nameProblem(v, dialog.entry.name)}
          onCancel={() => setDialog(null)}
          onConfirm={async (name) => {
            const target = join(parent(dialog.entry.path), name.trim())
            if (target !== dialog.entry.path) await window.api.rename(server.id, dialog.entry.path, target)
            setDialog(null)
            await load(path)
            setSelected(new Set([target]))
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={dialog.entries.length === 1 ? `Eliminar ${dialog.entries[0]!.name}` : `Eliminar ${dialog.entries.length} elementos`}
          confirmLabel="Eliminar"
          danger
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            const targets = dialog.entries
            setDialog(null)
            try {
              await window.api.remove(
                server.id,
                targets.map((e) => e.path)
              )
            } catch (err) {
              setNotice((err as Error).message)
            }
            void load(path)
          }}
        >
          {server.environment === 'prod' && <div className="notice error">Servidor de producción.</div>}
          Se borrará{dialog.entries.length > 1 ? 'n' : ''} definitivamente
          {dialog.entries.some(isDirLike) ? ', con todo su contenido' : ''}:
          <ul className="name-list">
            {dialog.entries.slice(0, 50).map((e) => (
              <li key={e.path}>
                {e.name}
                {isDirLike(e) ? '/' : ''}
              </li>
            ))}
            {dialog.entries.length > 50 && <li>… y {dialog.entries.length - 50} más</li>}
          </ul>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'conflicts' && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setDialog(null)}>
          <div className="dialog narrow" role="alertdialog" onKeyDown={(e) => e.key === 'Escape' && setDialog(null)}>
            <h2>Ya existen en el servidor</h2>
            <div className="body">
              En <code>{path}</code> ya hay:
              <ul className="name-list">
                {dialog.plan.conflicts.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <p className="note">Si sobrescribes, las carpetas se fusionan y los ficheros con el mismo nombre se sustituyen.</p>
            </div>
            <div className="footer">
              <button onClick={() => setDialog(null)}>Cancelar</button>
              <div className="spacer" />
              {dialog.plan.names.length > dialog.plan.conflicts.length && (
                <button
                  onClick={() => {
                    void window.api.startUpload(dialog.plan.token, 'skip').catch((err: Error) => setNotice(err.message))
                    setDialog(null)
                  }}
                >
                  Subir solo los nuevos
                </button>
              )}
              <button
                className="danger"
                autoFocus
                onClick={() => {
                  void window.api.startUpload(dialog.plan.token, 'overwrite').catch((err: Error) => setNotice(err.message))
                  setDialog(null)
                }}
              >
                Sobrescribir
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

