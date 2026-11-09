import { useCallback, useState } from 'react'
import type { ApacheReport, ApacheSite, CommandReport } from '@shared/modules'
import type { ServerSummary } from '@shared/types'
import { useModuleCall } from '../../lib/sudo'
import { Icon } from '../Icon'
import { FileLinks, FileLog, SubTabs, useLoad } from './common'
import { ServicePanel } from './ServicePanel'

interface Props {
  server: ServerSummary
  onOpenFile: (path: string) => void
}

type Tab = 'service' | 'sites' | 'config' | 'errors'

const REPORTS: [ApacheReport, string][] = [
  ['configtest', 'Probar configuración'],
  ['vhosts', 'Hosts virtuales (-S)'],
  ['modules', 'Módulos cargados (-M)']
]

export function ApacheView({ server, onOpenFile }: Props) {
  const call = useModuleCall(server)
  const overview = useLoad(useCallback(() => call('apache.overview', {}), [call]))
  const [tab, setTab] = useState<Tab>('service')
  const [report, setReport] = useState<{ kind: ApacheReport; result: CommandReport | null; error: string | null } | null>(null)
  const [siteBusy, setSiteBusy] = useState<string | null>(null)
  const [siteMessage, setSiteMessage] = useState<{ kind: 'ok' | 'error'; text: string; reload?: boolean } | null>(null)

  const data = overview.data
  if (overview.loading && !data) return <div className="welcome">Comprobando Apache…</div>
  if (overview.error) return <div className="notice error" style={{ margin: 12 }}>{overview.error}</div>
  if (!data?.installed) return <div className="welcome">Apache no está instalado en {server.name}.</div>

  const runReport = async (kind: ApacheReport) => {
    setReport({ kind, result: null, error: null })
    try {
      setReport({ kind, result: await call('apache.report', { report: kind }), error: null })
    } catch (err) {
      setReport({ kind, result: null, error: (err as Error).message })
    }
  }

  const toggleSite = async (site: ApacheSite) => {
    setSiteBusy(site.name)
    setSiteMessage(null)
    try {
      await call('apache.site', { name: site.name, enable: !site.enabled })
      setSiteMessage({ kind: 'ok', text: `${site.name} ${site.enabled ? 'desactivado' : 'activado'}. Recarga Apache para aplicarlo.`, reload: true })
      overview.reload()
    } catch (err) {
      setSiteMessage({ kind: 'error', text: (err as Error).message })
    } finally {
      setSiteBusy(null)
    }
  }

  const reload = async () => {
    if (!data.service) return
    setSiteMessage(null)
    try {
      const test = await call('apache.report', { report: 'configtest' })
      if (!test.ok) {
        setSiteMessage({ kind: 'error', text: `La configuración tiene errores; no se recarga:\n${test.text}` })
        return
      }
      await call('services.action', { unit: data.service, action: 'reload' })
      setSiteMessage({ kind: 'ok', text: 'Apache recargado.' })
    } catch (err) {
      setSiteMessage({ kind: 'error', text: (err as Error).message })
    }
  }

  return (
    <div className="module-view">
      <div className="module-header">
        <strong>Apache</strong>
        <span className="note">{data.version}</span>
        <div className="spacer" />
        <button className="icon" title="Actualizar" onClick={overview.reload}>
          <Icon name="refresh" />
        </button>
      </div>
      <SubTabs
        tabs={[
          ['service', 'Servicio'],
          ['sites', `Sitios (${data.sites.length})`],
          ['config', 'Configuración'],
          ['errors', 'Registro de errores']
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="module-body">
        {tab === 'service' &&
          (data.service ? (
            <ServicePanel server={server} unit={data.service} onOpenFile={onOpenFile} />
          ) : (
            <div className="empty-note">No se encontró el servicio de systemd de Apache (apache2 o httpd).</div>
          ))}

        {tab === 'sites' && (
          <>
            {siteMessage && (
              <div className={`notice ${siteMessage.kind}`} style={{ whiteSpace: 'pre-wrap' }}>
                {siteMessage.text}{' '}
                {siteMessage.reload && data.service && (
                  <button className="link" onClick={() => void reload()}>
                    Probar configuración y recargar
                  </button>
                )}
              </div>
            )}
            {data.layout !== 'debian' && data.sites.length > 0 && (
              <div className="notice warn">Activar y desactivar sitios solo está disponible con la estructura de Debian/Ubuntu (a2ensite).</div>
            )}
            {!data.sites.length && <div className="empty-note">No se encontraron sitios en sites-available ni en conf.d.</div>}
            <table className="result-table">
              <tbody>
                {data.sites.map((site) => (
                  <tr key={site.path}>
                    <td style={{ width: 24 }}>
                      <span className={`state-dot-sm ${site.enabled ? 'ok' : ''}`} />
                    </td>
                    <td>
                      <button className="link mono" onClick={() => onOpenFile(site.path)} title="Abrir en el editor">
                        {site.name}
                      </button>
                    </td>
                    <td className="note">{site.enabled ? 'activo' : 'inactivo'}</td>
                    <td className="row-action">
                      {data.layout === 'debian' && (
                        <button disabled={siteBusy !== null} onClick={() => void toggleSite(site)}>
                          {siteBusy === site.name ? '…' : site.enabled ? 'Desactivar' : 'Activar'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {tab === 'config' && (
          <>
            <div className="section-label">Ficheros principales</div>
            <FileLinks files={data.configFiles} onOpenFile={onOpenFile} empty="No se encontró la configuración principal." />
            <div className="service-actions" style={{ marginTop: 12 }}>
              {REPORTS.map(([kind, label]) => (
                <button key={kind} onClick={() => void runReport(kind)} disabled={report?.kind === kind && !report.result && !report.error}>
                  {label}
                </button>
              ))}
            </div>
            {report && (
              <>
                {report.error && <div className="notice error">{report.error}</div>}
                {report.result && (
                  <div className={`notice ${report.result.ok ? 'ok' : 'error'}`}>{report.result.ok ? 'Correcto' : 'Con errores'}</div>
                )}
                <pre className="log-text static">{report.result ? report.result.text : report.error ? '' : 'Ejecutando…'}</pre>
              </>
            )}
          </>
        )}

        {tab === 'errors' && <FileLog server={server} files={data.errorLogs} title="Registro de errores" />}
      </div>
    </div>
  )
}
