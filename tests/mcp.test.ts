import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectiveAccess, type McpActivity, type McpApprovalRequest } from '@shared/mcp'
import { SUDO_PASSWORD_REQUIRED } from '@shared/modules'
import type { ServerConfig } from '@shared/types'
import { buildMcpb, listTools } from '../src/main/mcp/bundle'
import { McpController } from '../src/main/mcp/server'
import type { ServerSession } from '../src/main/ssh/sessions'

const BRIDGE = join(import.meta.dirname, '../src/mcp-bridge/bridge.cjs')
let nextPort = 47900 + Math.floor(Math.random() * 50) * 2

const server = (id: string, name: string, environment: ServerConfig['environment'] = 'dev'): ServerConfig => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: 'admin',
  authMethod: 'agent',
  privateKeyPath: '',
  environment,
  initialPath: '',
  modules: ['security']
})

const SSH_EVENTS = [
  { time: 't1', kind: 'failed', user: 'root', ip: '203.0.113.5', method: 'password', pid: 1 },
  { time: 't2', kind: 'failed', user: 'admin', ip: '203.0.113.5', method: 'password', pid: 2 },
  { time: 't3', kind: 'invalid', user: 'oracle', ip: '198.51.100.7', method: null, pid: 3 },
  { time: 't4', kind: 'accepted', user: 'admin', ip: '192.0.2.10', method: 'publickey', pid: 4 }
]

/** Lee las entradas de un zip sin zip64 (como los que genera createZip). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let offset = 0
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extra = zip.readUInt16LE(offset + 28)
    const name = zip.toString('utf8', offset + 30, offset + 30 + nameLength)
    const start = offset + 30 + nameLength + extra
    out.set(name, inflateRawSync(zip.subarray(start, start + size)))
    offset = start + size
  }
  return out
}

describe('servidor MCP', () => {
  let dir: string
  let port: number
  let mcp: McpController
  let activity: McpActivity[]
  let calls: { call: string; args: unknown }[]
  let execs: { command: string; sudo: boolean }[]
  let opened: string[]
  let answer: boolean | null
  let asked: McpApprovalRequest[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-mcp-'))
    port = nextPort++
    activity = []
    calls = []
    execs = []
    opened = []
    asked = []
    answer = true
    const fakeSession = (id: string) => ({ id, client: { on: () => {} }, close: () => {} }) as unknown as ServerSession
    mcp = new McpController({
      dataDir: dir,
      version: '0.0.0-test',
      servers: async () => [server('a', 'Web'), server('b', 'BD'), server('p', 'Prod', 'prod')],
      appSessions: { isConnected: (id) => id === 'a', get: (id) => fakeSession(id) },
      openSession: async (config) => {
        opened.push(config.id)
        return fakeSession(config.id)
      },
      call: (async (_s: ServerSession, call: string, args: unknown) => {
        calls.push({ call, args })
        if (call === 'security.ssh') return { events: SSH_EVENTS, source: 'journal' }
        if (call === 'security.sessions') return { who: [], last: '' }
        if (call === 'security.firewall') throw new Error(SUDO_PASSWORD_REQUIRED)
        if (call === 'security.ban') return undefined
        throw new Error(`inesperado ${call}`)
      }) as never,
      exec: async (_s, command, { sudo }) => {
        execs.push({ command, sudo })
        return { code: 0, stdout: 'hola\n', stderr: '', truncated: false }
      },
      geoLookup: async (ips) => Object.fromEntries(ips.map((ip) => [ip, ip.startsWith('203.') ? 'CN' : null])),
      onActivity: (e) => activity.push(e),
      onApproval: (request) => {
        asked.push(request)
        if (answer !== null) setTimeout(() => mcp.respondApproval(request.id, answer!), 0)
        return answer !== null
      }
    })
    await mcp.init()
    await mcp.setPort(port)
  })

  afterEach(async () => {
    await mcp.shutdown()
    await rm(dir, { recursive: true, force: true })
  })

  async function connect(token?: string): Promise<Client> {
    const status = await mcp.status()
    const transport = new StreamableHTTPClientTransport(new URL(status.url), {
      requestInit: { headers: { Authorization: `Bearer ${token ?? status.token}` } }
    })
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    return client
  }

  const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as { text: string }[])[0]!.text

  it('está apagado por defecto, sin acceso a ningún servidor y con un token guardado', async () => {
    const status = await mcp.status()
    expect(status).toMatchObject({ enabled: false, running: false, access: {} })
    expect(status.token.length).toBeGreaterThanOrEqual(32)
    const stored = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
    expect(stored.token).toBe(status.token)
  })

  it('en producción «sin preguntar» se rebaja a «con aprobación»', () => {
    expect(effectiveAccess('prod', 'execute')).toBe('confirm')
    expect(effectiveAccess('dev', 'execute')).toBe('execute')
    expect(effectiveAccess('prod', undefined)).toBe('off')
  })

  it('solo enseña los servidores con acceso y resume los datos', async () => {
    await mcp.setAccess('a', 'read')
    await mcp.setEnabled(true)
    const client = await connect()
    const servers = JSON.parse(text(await client.callTool({ name: 'list_servers', arguments: {} })))
    expect(servers).toMatchObject([{ id: 'a', access: 'read', connected: true }])

    const hidden = await client.callTool({ name: 'active_sessions', arguments: { server: 'BD' } })
    expect(hidden.isError).toBe(true)
    expect(text(hidden)).toMatch(/con acceso/)

    const data = JSON.parse(text(await client.callTool({ name: 'ssh_access_report', arguments: { server: 'web', hours: 168 } })))
    expect(calls).toEqual([{ call: 'security.ssh', args: { sudo: true, hours: 168 } }])
    expect(data.totals).toMatchObject({ failedAttempts: 3, distinctFailingIps: 2, acceptedLogins: 1 })
    expect(data.topFailingIps[0]).toMatchObject({ ip: '203.0.113.5', attempts: 2, country: 'CN', users: ['root', 'admin'] })

    const fw = await client.callTool({ name: 'firewall_status', arguments: { server: 'a' } })
    expect(text(fw)).toMatch(/contraseña de sudo/)
    await client.close()
    expect(activity.map((a) => [a.tool, a.ok])).toEqual([
      ['list_servers', true],
      ['active_sessions', false],
      ['ssh_access_report', true],
      ['firewall_status', false]
    ])
  })

  it('con solo lectura no deja ejecutar', async () => {
    await mcp.setAccess('a', 'read')
    await mcp.setEnabled(true)
    const client = await connect()
    const result = await client.callTool({ name: 'run_command', arguments: { server: 'a', command: 'id' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/solo lectura/)
    expect(execs).toEqual([])
    expect(asked).toEqual([])
    await client.close()
  })

  it('con aprobación pregunta antes de ejecutar y respeta el rechazo', async () => {
    await mcp.setAccess('a', 'confirm')
    await mcp.setEnabled(true)
    const client = await connect()
    const ok = JSON.parse(text(await client.callTool({ name: 'run_command', arguments: { server: 'a', command: 'uptime', sudo: true } })))
    expect(ok).toMatchObject({ exitCode: 0, stdout: 'hola\n' })
    expect(asked[0]).toMatchObject({ serverName: 'Web', detail: 'uptime', sudo: true })
    expect(execs).toEqual([{ command: 'uptime', sudo: true }])

    answer = false
    const no = await client.callTool({ name: 'fail2ban_ban', arguments: { server: 'a', jail: 'sshd', ip: '203.0.113.5' } })
    expect(no.isError).toBe(true)
    expect(text(no)).toMatch(/rechazado/)
    expect(calls.some((c) => c.call === 'security.ban')).toBe(false)

    // Sin ventana que conteste, se rechaza al momento.
    answer = null
    const nobody = await client.callTool({ name: 'run_command', arguments: { server: 'a', command: 'id' } })
    expect(nobody.isError).toBe(true)
    await client.close()
    expect(activity.find((a) => a.tool === 'run_command' && a.ok)?.detail).toBe('sudo uptime')
  })

  it('«sin preguntar» ejecuta directamente, salvo en producción', async () => {
    await mcp.setAccess('b', 'execute')
    await mcp.setAccess('p', 'execute')
    await mcp.setEnabled(true)
    const client = await connect()
    await client.callTool({ name: 'run_command', arguments: { server: 'BD', command: 'df -h' } })
    expect(asked).toEqual([])
    await client.callTool({ name: 'run_command', arguments: { server: 'Prod', command: 'df -h' } })
    expect(asked.map((a) => a.serverName)).toEqual(['Prod'])
    // BD y Prod no están conectados en la app: el agente abre su propia conexión (una por servidor).
    await client.callTool({ name: 'run_command', arguments: { server: 'BD', command: 'free' } })
    expect(opened).toEqual(['b', 'p'])
    await client.close()
  })

  it('rechaza peticiones sin token, con token antiguo, desde navegador o con otro Host', async () => {
    await mcp.setEnabled(true)
    const { url, token } = await mcp.status()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401)
    expect((await fetch(url, { method: 'POST', headers: { ...headers, authorization: 'Bearer x' }, body })).status).toBe(401)
    const auth = { ...headers, authorization: `Bearer ${token}` }
    expect((await fetch(url, { method: 'POST', headers: { ...auth, origin: 'https://evil.example' }, body })).status).toBe(401)
    expect((await fetch(url.replace('127.0.0.1', 'localhost'), { method: 'POST', headers: auth, body })).status).toBe(200)

    await mcp.regenerateToken()
    expect((await fetch(url, { method: 'POST', headers: auth, body })).status).toBe(401)
  })

  it('al borrar un servidor se olvida su acceso', async () => {
    await mcp.setAccess('b', 'confirm')
    await mcp.forgetServer('b')
    expect((await mcp.status()).access).toEqual({})
    expect(JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')).access).toEqual({})
  })

  it('genera una extensión .mcpb con manifest, puente e icono', async () => {
    const tools = await listTools(mcp.createMcpServer())
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['ssh_access_report', 'run_command', 'service_action']))
    const zip = buildMcpb({ version: '9.9.9', dataDir: dir, bridgeSource: await readFile(BRIDGE, 'utf8'), tools, icon: Buffer.from('png') })
    const files = unzip(zip)
    expect([...files.keys()]).toEqual(['manifest.json', 'server/index.js', 'icon.png'])
    const manifest = JSON.parse(files.get('manifest.json')!.toString())
    expect(manifest).toMatchObject({ name: 'gestor-ssh', version: '9.9.9', server: { mcp_config: { env: { GESTOR_SSH_DATA_DIR: dir } } } })
    const bridge = files.get('server/index.js')!.toString()
    expect(bridge).not.toContain('/*@@')
    expect(bridge).toContain('"9.9.9"')
  })

  it('el puente stdio reenvía a la app y contesta solo si está apagada', async () => {
    await mcp.setAccess('a', 'read')
    const tools = await listTools(mcp.createMcpServer())
    const zip = buildMcpb({ version: '9.9.9', dataDir: dir, bridgeSource: await readFile(BRIDGE, 'utf8'), tools, icon: null })
    const bridgePath = join(dir, 'bridge.cjs')
    await writeFile(bridgePath, unzip(zip).get('server/index.js')!)

    const talk = (messages: object[]) =>
      new Promise<{ id: number; result?: { content?: { text: string }[]; isError?: boolean; tools?: unknown[] } }[]>((resolve, reject) => {
        const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, GESTOR_SSH_DATA_DIR: dir } })
        let out = ''
        child.stdout.on('data', (d) => (out += d))
        child.on('error', reject)
        child.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))))
        child.stdin.end(messages.map((m) => JSON.stringify(m)).join('\n') + '\n')
      })
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_servers', arguments: {} } }

    // Apagado: el puente contesta él mismo y explica qué hacer.
    const offline = await talk([init, list])
    expect(offline.find((m) => m.id === 2)!.result!.isError).toBe(true)
    expect(offline.find((m) => m.id === 2)!.result!.content![0]!.text).toMatch(/no está abierto/)

    await mcp.setEnabled(true)
    const online = await talk([init, list])
    expect(JSON.parse(online.find((m) => m.id === 2)!.result!.content![0]!.text)).toMatchObject([{ id: 'a' }])
  })
})
