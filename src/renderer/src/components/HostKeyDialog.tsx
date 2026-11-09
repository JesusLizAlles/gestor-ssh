import type { HostKeyRequest } from '@shared/types'

interface Props {
  request: HostKeyRequest
  onAnswer: (accept: boolean) => void
}

/** Primera conexión a un servidor: se enseña su huella y el usuario decide si confiar en ella. */
export function HostKeyDialog({ request, onAnswer }: Props) {
  return (
    <div className="modal-overlay">
      <div className="dialog" role="alertdialog" onKeyDown={(e) => e.key === 'Escape' && onAnswer(false)}>
        <h2>Servidor desconocido</h2>
        <div className="body">
          <p style={{ marginTop: 0 }}>
            Es la primera vez que te conectas a{' '}
            <strong>
              {request.host}:{request.port}
            </strong>
            . Su huella es:
          </p>
          <code className="fingerprint">{request.fingerprint}</code>
          <p className="note" style={{ marginBottom: 0 }}>
            Si puedes, compárala con la del servidor (<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>). Si la aceptas se
            recordará, y si algún día cambia la conexión se bloqueará.
          </p>
        </div>
        <div className="footer">
          <div className="spacer" />
          <button autoFocus onClick={() => onAnswer(false)}>
            Cancelar
          </button>
          <button className="primary" onClick={() => onAnswer(true)}>
            Confiar y conectar
          </button>
        </div>
      </div>
    </div>
  )
}
