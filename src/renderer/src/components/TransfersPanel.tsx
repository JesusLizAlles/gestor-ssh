import { formatRate, formatSize } from '@shared/format'
import type { TransferInfo } from '@shared/types'
import { Icon } from './Icon'

interface Props {
  transfers: TransferInfo[]
  onClose: () => void
  onClear: () => void
}

function describe(t: TransferInfo): { text: string; className: string } {
  switch (t.state) {
    case 'queued':
      return { text: 'En cola', className: '' }
    case 'running': {
      const seconds = (Date.now() - t.startedAt) / 1000
      const rate = seconds > 0.5 ? t.doneBytes / seconds : 0
      const files = t.totalFiles > 1 ? `${t.doneFiles}/${t.totalFiles} · ` : ''
      return { text: `${files}${formatSize(t.doneBytes)} de ${formatSize(t.totalBytes)}${rate ? ` · ${formatRate(rate)}` : ''}`, className: '' }
    }
    case 'done': {
      const files = t.totalFiles > 1 ? `${t.totalFiles} ficheros · ` : ''
      return { text: `${files}${formatSize(t.totalBytes)}`, className: 'done' }
    }
    case 'cancelled':
      return { text: 'Cancelada', className: '' }
    case 'error':
      return { text: t.error ?? 'Error', className: 'error' }
  }
}

/** Panel inferior con las descargas y subidas de la sesión. */
export function TransfersPanel({ transfers, onClose, onClear }: Props) {
  const finished = transfers.some((t) => t.state !== 'running' && t.state !== 'queued')
  return (
    <div className="transfers">
      <div className="section-title">
        <span>Transferencias</span>
        <div className="section-actions">
          <button className="link" disabled={!finished} onClick={onClear}>
            Limpiar terminadas
          </button>
          <button className="icon" title="Cerrar" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div className="transfers-list">
        {!transfers.length && <div className="empty-note">No hay transferencias. Descarga o sube ficheros desde el explorador.</div>}
        {[...transfers].reverse().map((t) => {
          const { text, className } = describe(t)
          const pct = t.totalBytes > 0 ? Math.min(100, (t.doneBytes / t.totalBytes) * 100) : t.state === 'done' ? 100 : 0
          return (
            <div className="transfer" key={t.id}>
              <Icon name={t.direction === 'download' ? 'download' : 'upload'} />
              <div style={{ minWidth: 0 }}>
                <div className="tname" title={t.name}>
                  {t.name}
                </div>
                <div className="tsub" title={t.destination}>
                  {t.direction === 'download' ? `${t.serverName} → ${t.destination}` : `→ ${t.serverName}:${t.destination}`}
                </div>
              </div>
              <div className={`progress ${t.state === 'done' ? 'done' : t.state === 'error' ? 'error' : ''}`}>
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className={`tstate ${className}`}>{text}</div>
              <div className="transfer-actions">
                {(t.state === 'running' || t.state === 'queued') && (
                  <button className="icon" title="Cancelar" onClick={() => void window.api.cancelTransfer(t.id)}>
                    <Icon name="close" />
                  </button>
                )}
                {t.state === 'done' && t.direction === 'download' && (
                  <button className="icon" title="Mostrar en la carpeta" onClick={() => void window.api.showInFolder(t.id)}>
                    <Icon name="folder" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
