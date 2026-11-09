import { useEffect, useRef, useState } from 'react'
import { formatSize, languageForFile } from '@shared/format'
import { basename } from '@shared/remote-path'
import { FILE_CHANGED_ERROR } from '@shared/types'
import { monaco } from '../lib/monaco'
import { ConfirmDialog } from './ConfirmDialog'
import { Icon } from './Icon'

interface Props {
  serverId: string
  path: string
  active: boolean
  connected: boolean
  onDirty: (dirty: boolean) => void
}

type Status = { kind: 'info' | 'ok' | 'error'; text: string } | null

/** Editor de un fichero de texto del servidor. Guarda con Ctrl+S y avisa si otro lo cambió entretanto. */
export function EditorView({ serverId, path, active, connected, onDirty }: Props) {
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
  onDirtyRef.current = onDirty

  const markDirty = (value: boolean) => {
    setDirty(value)
    onDirtyRef.current(value)
  }

  const load = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const file = await window.api.readTextFile(serverId, path)
      const editor = editorRef.current
      if (!editor) return
      editor.getModel()?.setValue(file.content)
      savedVersion.current = editor.getModel()!.getAlternativeVersionId()
      mtimeRef.current = file.mtime
      markDirty(false)
      setStatus({ kind: 'info', text: formatSize(file.size) })
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const save = async (force = false) => {
    const editor = editorRef.current
    if (!editor || saving) return
    setSaving(true)
    setStatus({ kind: 'info', text: 'Guardando…' })
    const version = editor.getModel()!.getAlternativeVersionId()
    try {
      const result = await window.api.saveTextFile({
        serverId,
        path,
        content: editor.getValue(),
        expectedMtime: force ? null : mtimeRef.current
      })
      mtimeRef.current = result.mtime
      savedVersion.current = version
      markDirty(editor.getModel()!.getAlternativeVersionId() !== version)
      setStatus({ kind: 'ok', text: `Guardado · ${formatSize(result.size)}` })
    } catch (err) {
      const message = (err as Error).message
      if (message === FILE_CHANGED_ERROR) {
        setStatus(null)
        setConfirm('overwrite')
      } else setStatus({ kind: 'error', text: message })
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
        <div className="spacer" />
        {status && <span className={`editor-status ${status.kind}`}>{status.text}</span>}
      </div>
      {loadError && <div className="files-error">{loadError}</div>}
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
