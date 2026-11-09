import { useState } from 'react'

interface Props {
  title: string
  label: string
  initial?: string
  confirmLabel: string
  /** Devuelve un mensaje de error para enseñarlo, o nada si el valor es válido. */
  validate?: (value: string) => string | null
  /** Si lanza un error, se muestra y el diálogo sigue abierto. */
  onConfirm: (value: string) => Promise<void>
  onCancel: () => void
}

/** Pide un texto (nombre de carpeta, nuevo nombre…). Al abrirse selecciona el nombre sin la extensión. */
export function PromptDialog({ title, label, initial = '', confirmLabel, validate, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const problem = validate?.(value) ?? null
    if (problem) return setError(problem)
    setBusy(true)
    try {
      await onConfirm(value)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form
        className="dialog narrow"
        onKeyDown={(e) => e.key === 'Escape' && !busy && onCancel()}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2>{title}</h2>
        <div className="body">
          <label className="note" htmlFor="prompt-value">
            {label}
          </label>
          <input
            id="prompt-value"
            autoFocus
            value={value}
            style={{ marginTop: 6 }}
            onFocus={(e) => {
              const dot = initial.lastIndexOf('.')
              e.target.setSelectionRange(0, dot > 0 ? dot : initial.length)
            }}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
          />
          {error && (
            <div className="notice error" style={{ marginTop: 10, marginBottom: 0 }}>
              {error}
            </div>
          )}
        </div>
        <div className="footer">
          <div className="spacer" />
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy || !value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
