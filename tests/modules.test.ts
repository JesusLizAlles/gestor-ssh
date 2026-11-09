import { describe, expect, it } from 'vitest'
import {
  isSiteName,
  isUnitName,
  parseApacheOverview,
  parseMysqlBatch,
  parseMysqlOverview,
  parseServiceDetail,
  parseServices,
  splitSections
} from '@shared/modules'
import { wrapScript } from '../src/main/ssh/commands'

const LIST_UNITS = `alsa-restore.service                                  loaded    active   exited  Save/Restore Sound Card State
● nginx.service                                       loaded    failed   failed  A high performance web server
ssh.service                                           loaded    active   running OpenBSD Secure Shell server
ghost.service                                         not-found inactive dead    ghost.service`

const UNIT_FILES = `accounts-daemon.service                      disabled        disabled
alsa-card-wait@.service                      static          -
alsa-restore.service                         static          -
nginx.service                                enabled         enabled
ssh.service                                  enabled         enabled`

describe('analizadores de los módulos', () => {
  it('combina list-units y list-unit-files', () => {
    const units = parseServices(LIST_UNITS, UNIT_FILES)
    expect(units.map((u) => u.name)).toEqual(['accounts-daemon.service', 'alsa-restore.service', 'ghost.service', 'nginx.service', 'ssh.service'])
    expect(units.find((u) => u.name === 'nginx.service')).toMatchObject({ active: 'failed', sub: 'failed', enabled: 'enabled', description: 'A high performance web server' })
    expect(units.find((u) => u.name === 'accounts-daemon.service')).toMatchObject({ active: 'inactive', sub: 'dead', enabled: 'disabled' })
    expect(units.find((u) => u.name === 'ghost.service')).toMatchObject({ load: 'not-found', enabled: null })
  })

  it('detalle de systemctl show', () => {
    const detail = parseServiceDetail(
      'x.service',
      'Id=systemd-journald.service\nDescription=Journal Service\nActiveState=active\nSubState=running\nUnitFileState=static\nActiveEnterTimestamp=Mon 2026-11-02 08:10:44 CET\nMainPID=289\nMemoryCurrent=14307328\nFragmentPath=/usr/lib/systemd/system/systemd-journald.service'
    )
    expect(detail).toMatchObject({ name: 'systemd-journald.service', active: 'active', mainPid: 289, memory: 14307328, since: 'Mon 2026-11-02 08:10:44 CET' })
    const stopped = parseServiceDetail('y.service', 'ActiveState=inactive\nMainPID=0\nMemoryCurrent=[not set]\nInactiveEnterTimestamp=ayer')
    expect(stopped).toMatchObject({ name: 'y.service', mainPid: null, memory: null, since: 'ayer' })
  })

  it('separa secciones', () => {
    const sections = splitSections('a\nb\n@@files\nc\n')
    expect(sections.get('')).toBe('a\nb')
    expect(sections.get('files')).toBe('c\n')
  })

  it('resumen de Apache (Debian y Red Hat)', () => {
    const debian = parseApacheOverview(
      'installed=1\nctl=apache2ctl\nservice=apache2.service\nversion=Server version: Apache/2.4.62 (Debian)\nroot=/etc/apache2\nconfig=/etc/apache2/apache2.conf\ndebian=1\nsite=1 /etc/apache2/sites-available/000-default.conf\nsite=0 /etc/apache2/sites-available/mi web.conf\nerrorlog=/var/log/apache2/error.log\n'
    )
    expect(debian).toMatchObject({ installed: true, ctl: 'apache2ctl', service: 'apache2.service', version: 'Apache/2.4.62 (Debian)', layout: 'debian' })
    expect(debian.sites).toEqual([
      { name: '000-default.conf', path: '/etc/apache2/sites-available/000-default.conf', enabled: true },
      { name: 'mi web.conf', path: '/etc/apache2/sites-available/mi web.conf', enabled: false }
    ])
    expect(parseApacheOverview('installed=1\nroot=/etc/httpd\n').layout).toBe('redhat')
    expect(parseApacheOverview('installed=0\n')).toMatchObject({ installed: false, sites: [], configFiles: [] })
  })

  it('resumen de MySQL', () => {
    expect(parseMysqlOverview('installed=1\nclient=mariadb\nservice=mariadb.service\nversion=mariadbd  Ver 11.4\nconfig=/etc/my.cnf\nconfig=/etc/my.cnf.d/server.cnf\n')).toEqual({
      installed: true,
      client: 'mariadb',
      service: 'mariadb.service',
      version: 'mariadbd  Ver 11.4',
      configFiles: ['/etc/my.cnf', '/etc/my.cnf.d/server.cnf'],
      errorLogs: []
    })
  })

  it('salida --batch de mysql', () => {
    const result = parseMysqlBatch('id\tconsulta\testado\n5\tSELECT 1\\n  FROM x\tNULL\n6\ta\\tb \\\\ c\t\n')
    expect(result.columns).toEqual(['id', 'consulta', 'estado'])
    expect(result.rows).toEqual([
      ['5', 'SELECT 1\n  FROM x', null],
      ['6', 'a\tb \\ c', '']
    ])
    expect(parseMysqlBatch('')).toEqual({ columns: [], rows: [] })
  })

  it('valida nombres de servicios y sitios', () => {
    expect(isUnitName('nginx.service')).toBe(true)
    expect(isUnitName('getty@tty1.service')).toBe(true)
    expect(isUnitName('systemd-fsck@dev-disk-by\\x2duuid.service')).toBe(true)
    for (const bad of ['nginx', 'a b.service', 'x;rm.service', "x'.service", '$(id).service']) expect(isUnitName(bad)).toBe(false)
    expect(isSiteName('000-default.conf')).toBe(true)
    expect(isSiteName('../etc')).toBe(false)
  })

  it('el script viaja en base64, sin comillas ni barras que otro shell pueda interpretar', () => {
    const command = wrapScript(`echo "it's \\ $HOME"`)
    expect(command).toMatch(/^sh -c 'eval "\$\(printf %s [A-Za-z0-9+/=]+ \| base64 -d\)"'$/)
  })
})
