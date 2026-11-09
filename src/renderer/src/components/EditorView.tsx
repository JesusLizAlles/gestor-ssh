import { useEffect, useRef, useState } from 'react'
import { formatSize, languageForFile } from '@shared/format'
import { basename } from '@shared/remote-path'
import { FILE_CHANGED_ERROR, type ServerSummary } from '@shared/types'
import { useSudo } from '../lib/sudo'
import { monaco } from '../lib/monaco'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'

interface Props {
  server: ServerSummary
  path: string
  active: boolean
  connected: boolean
  onDirty: (dirty: boolean) => void
}

type Status = { kind: 'info' | 'ok' | 'error'; text: string } | null

/** Editor de un fichero de texto del servidor. Guarda con Ctrl+S y avisa si otro lo cambió entretanto. */
export function EditorView({ server, path, active, connected, onDirty }: Props) {
  const serverId = server.id
  const withSudo = useSudo()
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const savedVersion = useRef(0)
  const mtimeRef = useRef<number | null>(null)
  const saveRef = useRef<(force?: boolean) => void>(() => {})
  const onDirtyRef = useRef(onDirty)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [confirm, setConfirm] = useState<'overwrite' | 'reload' | null>(null)
  /** Leer y guardar como root: se activa cuando falta permiso y el usuario lo pide. */
  const [sudo, setSudo] = useState(false)
  const [permissionProblem, setPermissionProblem] = useState<'read' | 'write' | null>(null)
  const sudoRef = useRef(false)
  onDirtyRef.current = onDirty

  const markDirty = (value: boolean) => {
    setDirty(value)
    onDirtyRef.current(value)
  }

  const load = async (asRoot = sudoRef.current) => {
    setLoading(true)
    setLoadError(null)
    setPermissionProblem(null)
    try {
      const file = asRoot
        ? await withSudo(server, () => window.api.readTextFile(serverId, path, true))
        : await window.api.readTextFile(serverId, path)
      const editor = editorRef.current
      if (!editor) return
      editor.getModel()?.setValue(file.content)
      savedVersion.current = editor.getModel()!.getAlternativeVersionId()
      mtimeRef.current = file.mtime
      markDirty(false)
      setStatus({ kind: 'info', text: formatSize(file.size) })
    } catch (err) {
      const message = (err as Error).message
      setLoadError(message)
      if (!asRoot && message.startsWith('Permiso denegado')) setPermissionProblem('read')
    } finally {
      setLoading(false)
    }
  }

  const enableSudo = (then: () => void) => {
    sudoRef.current = true
    setSudo(true)
    setPermissionProblem(null)
    then()
  }

  const save = async (force = false, asRoot = sudoRef.current) => {
    const editor = editorRef.current
    if (!editor || saving) return
    setSaving(true)
    setStatus({ kind: 'info', text: 'Guardando…' })
    const version = editor.getModel()!.getAlternativeVersionId()
    try {
      const input = { serverId, path, content: editor.getValue(), expectedMtime: force ? null : mtimeRef.current, sudo: asRoot }
      const result = asRoot ? await withSudo(server, () => window.api.saveTextFile(input)) : await window.api.saveTextFile(input)
      mtimeRef.current = result.mtime
      savedVersion.current = version
      markDirty(editor.getModel()!.getAlternativeVersionId() !== version)
      setStatus({ kind: 'ok', text: `Guardado · ${formatSize(result.size)}` })
    } catch (err) {
      const message = (err as Error).message
      if (message === FILE_CHANGED_ERROR) {
        setStatus(null)
        setConfirm('overwrite')
      } else {
        setStatus({ kind: 'error', text: message })
        if (!asRoot && message.startsWith('Permiso denegado')) setPermissionProblem('write')
      }
    } finally {
      setSaving(false)
    }
  }
  saveRef.current = (force) => void save(force)

  useEffect(() => {
    const editor = monaco.editor.create(hostRef.current!, {
      value: '',
      language: languageForFile(basename(path)),
      theme: 'gestor-dark',
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: 13,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 4,
      detectIndentation: true
    })
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    editor.onDidChangeModelContent(() => {
      const isDirty = editor.getModel()!.getAlternativeVersionId() !== savedVersion.current
      setDirty(isDirty)
      onDirtyRef.current(isDirty)
    })
    void load()
    return () => {
      editor.getModel()?.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) requestAnimationFrame(() => editorRef.current?.focus())
  }, [active])

  return (
    <>
      <div className="toolbar">
        <button className="primary" disabled={!dirty || saving || !connected || !!loadError} onClick={() => void save()} title="Guardar (Ctrl+S)">
          <Icon name="save" /> Guardar
        </button>
        <button disabled={loading || saving || !connected} onClick={() => (dirty ? setConfirm('reload') : void load())} title="Volver a leer el fichero del servidor">
          <Icon name="refresh" /> Recargar
        </button>
        <div className="sep" />
        <span className="path-label" title={path}>
          {path}
        </span>
        {sudo && (
          <span className="badge prod" title="Se lee y se guarda como root">
            sudo
          </span>
        )}
        <div className="spacer" />
        {status && <span className={`editor-status ${status.kind}`}>{status.text}</span>}
        {permissionProblem === 'write' && (
          <button className="primary" onClick={() => enableSudo(() => void save(false, true))}>
            Guardar con sudo
          </button>
        )}
      </div>
      {loadError && (
        <div className="files-error">
          {loadError}
          {permissionProblem === 'read' && (
            <div style={{ marginTop: 10 }}>
              <button className="primary" onClick={() => enableSudo(() => void load(true))}>
                Abrir con sudo
              </button>
            </div>
          )}
        </div>
      )}
      <div className="editor-host" ref={hostRef} style={loadError ? { display: 'none' } : undefined} />
      {confirm === 'overwrite' && (
        <ConfirmDialog
          title="El fichero ha cambiado"
          confirmLabel="Sobrescribir"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            void save(true)
          }}
        >
          Alguien ha modificado <code>{basename(path)}</code> en el servidor desde que lo abriste. Si lo sobrescribes, se perderán esos cambios.
        </ConfirmDialog>
      )}
      {confirm === 'reload' && (
        <ConfirmDialog
          title="Descartar cambios"
          confirmLabel="Recargar"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            void load()
          }}
        >
          Tienes cambios sin guardar en <code>{basename(path)}</code>. Al recargar se perderán.
        </ConfirmDialog>
      )}
    </>
  )
}
