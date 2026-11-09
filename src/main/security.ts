import { isIP } from 'node:net'
import { z } from 'zod'
import type { ModuleCalls } from '@shared/modules'
import {
  isJailName,
  parseJail,
  parseJailList,
  parseSs,
  parseSshLog,
  parseWho,
  type FirewallResult,
  type JailStatus
} from '@shared/security'
import { shellQuote as q } from '@shared/shell'
import { outputText, runScript, type RunResult } from './ssh/commands'
import type { ServerSession } from './ssh/sessions'

type SecurityCall = Extract<keyof ModuleCalls, `security.${string}`>

const text = (r: RunResult) => r.stdout.toString('utf8')
const empty = z.object({}).strict()

export const securitySchemas: { [K in SecurityCall]: z.ZodType<ModuleCalls[K]['args']> } = {
  'security.connections': z.object({ sudo: z.boolean() }),
  'security.ssh': z.object({ sudo: z.boolean(), hours: z.union([z.literal(24), z.literal(168), z.literal(720)]) }),
  'security.sessions': empty,
  'security.fail2ban': empty,
  'security.ban': z.object({
    jail: z.string().refine(isJailName, 'jail no válida'),
    ip: z.string().refine((ip) => isIP(ip) !== 0, 'IP no válida'),
    ban: z.boolean()
  }),
  'security.firewall': empty
}

/** IP desde la que está conectada la app, tal como la ve el servidor ($SSH_CLIENT; sudo la borraría). */
async function clientIp(session: ServerSession): Promise<string | null> {
  const result = await runScript(session, 'printf %s "${SSH_CLIENT%% *}"')
  const ip = text(result).trim()
  return isIP(ip) ? ip : null
}

// Líneas de autenticación que interesan del registro de sshd (se filtran ya en el servidor).
const SSH_PATTERN = 'Failed (password|publickey|keyboard-interactive|none)|Invalid user|Accepted '

function sshScript(hours: number): string {
  return `
P=${q(SSH_PATTERN)}
echo @@journal
if command -v journalctl >/dev/null 2>&1; then
  journalctl _COMM=sshd _COMM=sshd-session --since ${q(`${hours} hours ago`)} -o short-iso --no-pager 2>/dev/null | grep -E "$P" | tail -n 20000
fi
echo @@file
for f in /var/log/auth.log /var/log/secure; do
  if [ -r "$f" ]; then echo "source=$f"; grep -E "$P" "$f" | tail -n 20000; break; fi
done
true
`
}

const FAIL2BAN = `
if ! command -v fail2ban-client >/dev/null 2>&1; then echo @@missing; exit 0; fi
status=$(fail2ban-client status 2>&1) || { echo @@error; echo "$status"; exit 0; }
echo "$status"
for j in $(printf '%s\\n' "$status" | sed -n 's/.*Jail list:[[:space:]]*//p' | tr ',' ' '); do
  echo "@@jail $j"
  fail2ban-client status "$j" 2>&1
done
true
`

const FIREWALL = `
if command -v ufw >/dev/null 2>&1; then echo tool=ufw; ufw status verbose 2>&1; exit 0; fi
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then echo tool=firewalld; firewall-cmd --list-all 2>&1; exit 0; fi
if command -v nft >/dev/null 2>&1; then echo tool=nftables; nft list ruleset 2>&1; exit 0; fi
if command -v iptables >/dev/null 2>&1; then echo tool=iptables; iptables -S 2>&1; exit 0; fi
echo tool=
`

type Handlers = { [K in SecurityCall]: (session: ServerSession, args: ModuleCalls[K]['args']) => Promise<ModuleCalls[K]['result']> }

export const securityHandlers: Handlers = {
  'security.connections': async (session, { sudo }) => {
    const result = await runScript(session, 'ss -Htuanp', { sudo })
    if (result.code === 127) throw new Error('El servidor no tiene «ss» (paquete iproute2)')
    if (result.code !== 0) throw new Error(outputText(result) || 'No se pudieron listar las conexiones')
    return { sockets: parseSs(text(result)), clientIp: await clientIp(session) }
  },

  'security.ssh': async (session, { sudo, hours }) => {
    const result = await runScript(session, sshScript(hours), { sudo, timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 })
    const output = text(result)
    const fileStart = output.indexOf('\n@@file\n')
    const journal = output.slice(output.indexOf('@@journal\n') + 10, fileStart < 0 ? undefined : fileStart)
    const file = fileStart < 0 ? '' : output.slice(fileStart + 8)
    const fromJournal = parseSshLog(journal)
    if (fromJournal.length) return { events: fromJournal, source: 'journal' }
    const source = /^source=(.*)$/m.exec(file)?.[1] ?? ''
    // En el fichero no hay filtro por fecha (syslog no guarda el año): se enseña lo último que haya.
    return { events: parseSshLog(file), source: source || (sudo ? 'journal' : 'journal (sin sudo puede faltar información)') }
  },

  'security.sessions': async (session) => {
    const result = await runScript(session, 'who 2>/dev/null; echo @@last; last -i -n 40 2>/dev/null || last -n 40 2>&1; true')
    const output = text(result)
    const split = output.indexOf('@@last\n')
    return { who: parseWho(split < 0 ? output : output.slice(0, split)), last: split < 0 ? '' : output.slice(split + 7).trimEnd() }
  },

  'security.fail2ban': async (session) => {
    const output = text(await runScript(session, FAIL2BAN, { sudo: true }))
    if (output.startsWith('@@missing')) return { installed: false, error: null, jails: [] }
    if (output.startsWith('@@error')) return { installed: true, error: output.slice(8).trim() || 'fail2ban no responde', jails: [] }
    const blocks = output.split(/^@@jail /m)
    const jails: JailStatus[] = blocks.slice(1).map((block) => {
      const newline = block.indexOf('\n')
      return parseJail(block.slice(0, newline).trim(), block.slice(newline + 1))
    })
    // Por si alguna jail no devolvió su bloque: que aparezca igualmente.
    for (const name of parseJailList(blocks[0] ?? '')) if (!jails.some((j) => j.name === name)) jails.push(parseJail(name, ''))
    return { installed: true, error: null, jails }
  },

  'security.ban': async (session, { jail, ip, ban }) => {
    if (ban && ip === (await clientIp(session))) {
      throw new Error(`${ip} es la IP desde la que estás conectado: bloquearla te dejaría sin acceso al servidor`)
    }
    const result = await runScript(session, `fail2ban-client set ${q(jail)} ${ban ? 'banip' : 'unbanip'} ${q(ip)}`, { sudo: true })
    if (result.code !== 0) throw new Error(outputText(result) || `fail2ban no pudo ${ban ? 'bloquear' : 'desbloquear'} ${ip}`)
  },

  'security.firewall': async (session): Promise<FirewallResult> => {
    const output = text(await runScript(session, FIREWALL, { sudo: true }))
    const newline = output.indexOf('\n')
    const tool = (newline < 0 ? output : output.slice(0, newline)).replace(/^tool=/, '').trim()
    const body = newline < 0 ? '' : output.slice(newline + 1).trimEnd()
    let active: boolean | null = null
    if (tool === 'ufw') active = /^Status:\s*active/m.test(body)
    else if (tool === 'firewalld') active = true
    else if (tool === 'nftables') active = /\bchain\b/.test(body)
    return { tool: (tool || null) as FirewallResult['tool'], active, text: body }
  }
}
