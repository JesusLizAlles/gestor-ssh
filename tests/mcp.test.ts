import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpActivity } from '@shared/mcp'
import { SUDO_PASSWORD_REQUIRED } from '@shared/modules'
import type { ServerConfig } from '@shared/types'
import { McpController } from '../src/main/mcp/server'
import type { ServerSession } from '../src/main/ssh/sessions'

const PORT = 47900 + Math.floor(Math.random() * 90)

const server = (id: string, name: string): ServerConfig => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: 'admin',
  authMethod: 'agent',
  privateKeyPath: '',
  environment: 'prod',
  initialPath: '',
  modules: ['security']
})

const SSH_EVENTS = [
  { time: 't1', kind: 'failed', user: 'root', ip: '203.0.113.5', method: 'password', pid: 1 },
  { time: 't2', kind: 'failed', user: 'admin', ip: '203.0.113.5', method: 'password', pid: 2 },
  { time: 't3', kind: 'invalid', user: 'oracle', ip: '198.51.100.7', method: null, pid: 3 },
  { time: 't4', kind: 'accepted', user: 'admin', ip: '192.0.2.10', method: 'publickey', pid: 4 }
]

describe('servidor MCP', () => {
  let dir: string
  let mcp: McpController
  let activity: McpActivity[]
  let calls: { call: string; args: unknown }[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gestor-mcp-'))
    activity = []
    calls = []
    const fakeSession = {} as ServerSession
    mcp = new McpController({
      dataDir: dir,
      version: '0.0.0-test',
      tools: {
        listServers: async () => [server('a', 'Web'), server('b', 'BD')],
        isConnected: (id) => id === 'a',
        session: () => fakeSession,
        call: (async (_s: ServerSession, call: string, args: unknown) => {
          calls.push({ call, args })
          if (call === 'security.ssh') return { events: SSH_EVENTS, source: 'journal' }
          if (call === 'security.firewall') throw new Error(SUDO_PASSWORD_REQUIRED)
          throw new Error(`inesperado ${call}`)
        }) as never,
        geoLookup: async (ips) => Object.fromEntries(ips.map((ip) => [ip, ip.startsWith('203.') ? 'CN' : null]))
      },
      onActivity: (e) => activity.push(e)
    })
    await mcp.init()
    await mcp.setPort(PORT)
  })

  afterEach(async () => {
    await mcp.stop()
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

  it('está apagado por defecto y guarda un token aleatorio con permisos 0600', async () => {
    const status = await mcp.status()
    expect(status.enabled).toBe(false)
    expect(status.running).toBe(false)
    expect(status.token.length).toBeGreaterThanOrEqual(32)
    const stored = JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))
    expect(stored.token).toBe(status.token)
  })

  it('expone solo herramientas de lectura y responde con datos resumidos', async () => {
    await mcp.setEnabled(true)
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('ssh_access_report')
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
    expect(tools.map((t) => t.name)).not.toContain('ban_ip')

    const list = await client.callTool({ name: 'list_servers', arguments: {} })
    const servers = JSON.parse((list.content as { text: string }[])[0]!.text)
    expect(servers).toMatchObject([{ id: 'a', connected: true }, { id: 'b', connected: false }])

    const report = await client.callTool({ name: 'ssh_access_report', arguments: { server: 'web', hours: 168 } })
    const data = JSON.parse((report.content as { text: string }[])[0]!.text)
    expect(calls).toEqual([{ call: 'security.ssh', args: { sudo: true, hours: 168 } }])
    expect(data.totals).toMatchObject({ failedAttempts: 3, distinctFailingIps: 2, acceptedLogins: 1 })
    expect(data.topFailingIps[0]).toMatchObject({ ip: '203.0.113.5', attempts: 2, country: 'CN', users: ['root', 'admin'] })
    expect(data.acceptedLogins).toEqual([{ user: 'admin', ip: '192.0.2.10', method: 'publickey', count: 1, last: 't4', country: null }])
    await client.close()

    expect(activity.map((a) => [a.tool, a.server, a.ok])).toEqual([
      ['list_servers', null, true],
      ['ssh_access_report', 'Web', true]
    ])
  })

  it('devuelve errores legibles: servidor desconectado y sudo sin contraseña', async () => {
    await mcp.setEnabled(true)
    const client = await connect()
    const offline = await client.callTool({ name: 'active_sessions', arguments: { server: 'BD' } })
    expect(offline.isError).toBe(true)
    expect((offline.content as { text: string }[])[0]!.text).toMatch(/no está conectado/)
    const fw = await client.callTool({ name: 'firewall_status', arguments: { server: 'a' } })
    expect(fw.isError).toBe(true)
    expect((fw.content as { text: string }[])[0]!.text).toMatch(/contraseña de sudo/)
    await client.close()
    expect(activity.at(-1)).toMatchObject({ tool: 'firewall_status', ok: false })
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
    expect((await fetch(url.replace('127.0.0.1', 'localhost'), { method: 'POST', headers: auth, body })).status).not.toBe(401)

    await mcp.regenerateToken()
    expect((await fetch(url, { method: 'POST', headers: auth, body })).status).toBe(401)
  })

  it('al desactivarlo deja de escuchar', async () => {
    await mcp.setEnabled(true)
    expect((await mcp.status()).running).toBe(true)
    await mcp.setEnabled(false)
    const { url } = await mcp.status()
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
  })
})
