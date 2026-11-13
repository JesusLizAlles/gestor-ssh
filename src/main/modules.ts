import { z } from 'zod'
import {
  isSiteName,
  isUnitName,
  parseApacheOverview,
  parseMysqlBatch,
  parseMysqlOverview,
  parseServiceDetail,
  parseServices,
  splitSections,
  type ModuleCall,
  type ModuleCalls,
  MODULE_IDS,
  type ModuleId,
  type MysqlQuery,
  type ServiceDetail
} from '@shared/modules'
import { shellQuote } from '@shared/shell'
import { performanceHandlers, performanceSchemas } from './performance'
import { securityHandlers, securitySchemas } from './security'
import { outputText, runScript } from './ssh/commands'
import type { ServerSession } from './ssh/sessions'

const q = shellQuote

const unit = z.string().refine(isUnitName, 'nombre de servicio no válido')
const lines = z.number().int().min(10).max(5000)
const absolutePath = z
  .string()
  .min(2)
  .max(4096)
  .refine((p) => p.startsWith('/') && !p.includes('\0'), 'ruta no válida')
const empty = z.object({}).strict()

/** Argumentos de cada llamada (se validan siempre: vienen del renderer). */
const schemas: { [K in ModuleCall]: z.ZodType<ModuleCalls[K]['args']> } = {
  'services.list': empty,
  'services.show': z.object({ unit }),
  'services.logs': z.object({ unit, lines, sudo: z.boolean() }),
  'services.action': z.object({ unit, action: z.enum(['start', 'stop', 'restart', 'reload', 'enable', 'disable']) }),
  'files.tail': z.object({ path: absolutePath, lines }),
  'apache.overview': empty,
  'apache.report': z.object({ report: z.enum(['configtest', 'vhosts', 'modules']) }),
  'apache.site': z.object({ name: z.string().refine(isSiteName, 'nombre de sitio no válido'), enable: z.boolean() }),
  'mysql.overview': empty,
  'mysql.query': z.object({ query: z.enum(['databases', 'status', 'processlist']), sudo: z.boolean() }),
  'mysql.kill': z.object({ id: z.number().int().positive(), sudo: z.boolean() }),
  ...securitySchemas,
  ...performanceSchemas
}

const text = (buffer: Buffer) => buffer.toString('utf8')

/** Falla con el mensaje del comando si no terminó bien. */
function ensureOk(result: Awaited<ReturnType<typeof runScript>>, what: string): void {
  if (result.code === 0) return
  const detail = outputText(result).split('\n').slice(-6).join('\n')
  throw new Error(detail ? `${what}: ${detail}` : `${what} (código ${result.code})`)
}

const SHOW_PROPS = 'Id,Description,ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,InactiveEnterTimestamp,MainPID,MemoryCurrent,FragmentPath'

async function showService(session: ServerSession, name: string): Promise<ServiceDetail> {
  const result = await runScript(session, `systemctl show --no-pager -p ${SHOW_PROPS} -- ${q(name)}`)
  ensureOk(result, 'No se pudo consultar el servicio')
  return parseServiceDetail(name, text(result.stdout))
}

/** Lee el final de un fichero; si no hay permiso, lo vuelve a intentar con sudo. */
async function tail(session: ServerSession, path: string, count: number): Promise<{ text: string; limited: boolean }> {
  const script = `tail -n ${count} -- ${q(path)}`
  let result = await runScript(session, script)
  if (result.code !== 0 && /Permission denied/i.test(result.stderr)) result = await runScript(session, script, { sudo: true })
  ensureOk(result, `No se pudo leer ${path}`)
  return { text: text(result.stdout), limited: false }
}

const APACHE_OVERVIEW = `
if command -v apache2ctl >/dev/null 2>&1; then ctl=apache2ctl
elif command -v apachectl >/dev/null 2>&1; then ctl=apachectl
elif command -v httpd >/dev/null 2>&1; then ctl=httpd
else echo installed=0; exit 0; fi
echo installed=1
echo ctl=$ctl
for s in apache2 httpd; do
  if systemctl list-unit-files "$s.service" --no-legend --no-pager 2>/dev/null | grep -q .; then echo service=$s.service; break; fi
done
echo "version=$($ctl -v 2>/dev/null | head -n 1)"
[ -d /etc/apache2 ] && echo root=/etc/apache2
[ -d /etc/httpd ] && echo root=/etc/httpd
for f in /etc/apache2/apache2.conf /etc/apache2/ports.conf /etc/httpd/conf/httpd.conf; do [ -f "$f" ] && echo config=$f; done
if [ -d /etc/apache2/sites-available ]; then
  echo debian=1
  for f in /etc/apache2/sites-available/*; do
    [ -f "$f" ] || continue
    n=$(basename "$f")
    if [ -e "/etc/apache2/sites-enabled/$n" ]; then echo "site=1 $f"; else echo "site=0 $f"; fi
  done
elif [ -d /etc/httpd/conf.d ]; then
  for f in /etc/httpd/conf.d/*; do
    [ -f "$f" ] || continue
    case "$f" in *.conf) echo "site=1 $f";; *) echo "site=0 $f";; esac
  done
fi
for f in /var/log/apache2/error.log /var/log/httpd/error_log; do [ -e "$f" ] && echo errorlog=$f; done
true
`

const MYSQL_OVERVIEW = `
server=
for b in mariadbd mysqld; do if command -v $b >/dev/null 2>&1; then server=$b; break; fi; done
client=
for c in mariadb mysql; do if command -v $c >/dev/null 2>&1; then client=$c; break; fi; done
if [ -z "$server" ] && [ -z "$client" ]; then echo installed=0; exit 0; fi
echo installed=1
[ -n "$client" ] && echo client=$client
for s in mariadb mysql mysqld; do
  if systemctl list-unit-files "$s.service" --no-legend --no-pager 2>/dev/null | grep -q .; then echo service=$s.service; break; fi
done
if [ -n "$server" ]; then echo "version=$($server --version 2>/dev/null | head -n 1)"; else echo "version=$($client --version 2>/dev/null | head -n 1)"; fi
for f in /etc/mysql/my.cnf /etc/my.cnf /etc/mysql/mariadb.cnf /etc/mysql/mariadb.conf.d/*.cnf /etc/mysql/mysql.conf.d/*.cnf /etc/mysql/conf.d/*.cnf /etc/my.cnf.d/*.cnf; do
  [ -f "$f" ] && echo config=$f
done
for f in /var/log/mysql/error.log /var/log/mysql/mysql.log /var/log/mariadb/mariadb.log /var/log/mysqld.log; do [ -e "$f" ] && echo errorlog=$f; done
true
`

/** Consultas fijas de la vista de MySQL. Con `columns`, la salida va sin cabecera (varias sentencias). */
const MYSQL_QUERIES: Record<MysqlQuery, { sql: string; columns?: string[] }> = {
  databases: {
    sql: `SELECT s.SCHEMA_NAME AS base_de_datos, COUNT(t.TABLE_NAME) AS tablas,
    COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS bytes, s.DEFAULT_CHARACTER_SET_NAME AS juego, s.DEFAULT_COLLATION_NAME AS colacion
    FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
    GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME ORDER BY s.SCHEMA_NAME`
  },
  // SHOW funciona igual en MySQL 8 y en MariaDB (information_schema.GLOBAL_STATUS no existe en MySQL 8).
  status: {
    sql: `SELECT 'version', VERSION();
    SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Questions','Slow_queries','Aborted_connects');
    SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','datadir','innodb_buffer_pool_size','bind_address','port')`,
    columns: ['variable', 'valor']
  },
  processlist: {
    sql: `SELECT ID AS id, USER AS usuario, HOST AS origen, DB AS base_de_datos, COMMAND AS orden, TIME AS segundos, STATE AS estado,
    LEFT(INFO, 300) AS consulta FROM information_schema.PROCESSLIST ORDER BY TIME DESC`
  }
}

async function mysql(session: ServerSession, sql: string, sudo: boolean, header = true): Promise<string> {
  const overview = parseMysqlOverview(text((await runScript(session, MYSQL_OVERVIEW)).stdout))
  if (!overview.client) throw new Error('No hay cliente mysql/mariadb instalado en el servidor')
  const result = await runScript(session, `${overview.client} --batch ${header ? '' : '--skip-column-names '}--default-character-set=utf8mb4 -e ${q(sql)}`, { sudo })
  if (result.code !== 0 && /Access denied/i.test(result.stderr)) {
    throw new Error(
      sudo
        ? 'MySQL no deja entrar a root por el socket (sudo). Crea un ~/.my.cnf con usuario y contraseña en el servidor y desactiva «Usar sudo».'
        : 'Acceso denegado. Crea un ~/.my.cnf con usuario y contraseña en el servidor, o activa «Usar sudo» si root entra por el socket.'
    )
  }
  ensureOk(result, 'La consulta falló')
  return text(result.stdout)
}

type Handlers = { [K in ModuleCall]: (session: ServerSession, args: ModuleCalls[K]['args']) => Promise<ModuleCalls[K]['result']> }

const handlers: Handlers = {
  'services.list': async (session) => {
    const result = await runScript(
      session,
      'systemctl list-units --type=service --all --no-legend --no-pager --plain; echo @@files; systemctl list-unit-files --type=service --no-legend --no-pager'
    )
    const sections = splitSections(text(result.stdout))
    if (result.code !== 0 && !sections.get('')?.trim()) ensureOk(result, 'No se pudo listar los servicios (¿usa systemd?)')
    return parseServices(sections.get('') ?? '', sections.get('files') ?? '')
  },
  'services.show': (session, { unit }) => showService(session, unit),
  'services.logs': async (session, { unit, lines, sudo }) => {
    const result = await runScript(session, `journalctl -u ${q(unit)} -n ${lines} --no-pager -o short-iso`, { sudo })
    const limited = !sudo && /not seeing messages|insufficient permissions|No journal files/i.test(result.stderr)
    if (result.code !== 0 && !limited) ensureOk(result, 'No se pudo leer el registro')
    return { text: text(result.stdout), limited }
  },
  'services.action': async (session, { unit, action }) => {
    const result = await runScript(session, `systemctl ${action} -- ${q(unit)}`, { sudo: true, timeoutMs: 120_000 })
    ensureOk(result, `No se pudo ${{ start: 'arrancar', stop: 'parar', restart: 'reiniciar', reload: 'recargar', enable: 'habilitar', disable: 'deshabilitar' }[action]} ${unit}`)
    return showService(session, unit)
  },
  'files.tail': (session, { path, lines }) => tail(session, path, lines),

  'apache.overview': async (session) => parseApacheOverview(text((await runScript(session, APACHE_OVERVIEW)).stdout)),
  'apache.report': async (session, { report }) => {
    const overview = parseApacheOverview(text((await runScript(session, APACHE_OVERVIEW)).stdout))
    if (!overview.ctl) throw new Error('Apache no está instalado')
    const flag = { configtest: 'configtest', vhosts: '-S', modules: '-M' }[report]
    const result = await runScript(session, `${overview.ctl} ${flag}`, { sudo: true })
    return { ok: result.code === 0, text: outputText(result) }
  },
  'apache.site': async (session, { name, enable }) => {
    const result = await runScript(session, `${enable ? 'a2ensite' : 'a2dissite'} -q -- ${q(name)}`, { sudo: true })
    ensureOk(result, enable ? `No se pudo activar ${name}` : `No se pudo desactivar ${name}`)
    return { ok: true, text: outputText(result) }
  },

  'mysql.overview': async (session) => parseMysqlOverview(text((await runScript(session, MYSQL_OVERVIEW)).stdout)),
  'mysql.query': async (session, { query, sudo }) => {
    const { sql, columns } = MYSQL_QUERIES[query]
    const output = await mysql(session, sql, sudo, !columns)
    return columns ? parseMysqlBatch(`${columns.join('\t')}\n${output}`) : parseMysqlBatch(output)
  },
  'mysql.kill': async (session, { id, sudo }) => {
    await mysql(session, `KILL ${id}`, sudo)
  },
  ...securityHandlers,
  ...performanceHandlers
}

export function isModuleCall(call: unknown): call is ModuleCall {
  return typeof call === 'string' && Object.hasOwn(handlers, call)
}

/** Ejecuta una llamada de un módulo con sus argumentos ya validados. */
export async function runModuleCall(session: ServerSession, call: ModuleCall, rawArgs: unknown): Promise<unknown> {
  const args = schemas[call].parse(rawArgs ?? {})
  return (handlers[call] as (s: ServerSession, a: unknown) => Promise<unknown>)(session, args)
}

const DETECT = `
[ -r /proc/stat ] && echo performance
command -v systemctl >/dev/null 2>&1 && echo services
if command -v apache2ctl >/dev/null 2>&1 || command -v apachectl >/dev/null 2>&1 || command -v httpd >/dev/null 2>&1; then echo apache; fi
if command -v mariadbd >/dev/null 2>&1 || command -v mysqld >/dev/null 2>&1 || command -v mariadb >/dev/null 2>&1 || command -v mysql >/dev/null 2>&1; then echo mysql; fi
command -v ss >/dev/null 2>&1 && echo security
true
`

/** Qué módulos tienen sentido en este servidor (por lo que hay instalado). */
export async function detectModules(session: ServerSession): Promise<ModuleId[]> {
  const result = await runScript(session, DETECT)
  const found = new Set(text(result.stdout).split('\n').map((l) => l.trim()))
  return MODULE_IDS.filter((id) => found.has(id))
}
