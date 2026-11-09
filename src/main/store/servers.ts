import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SaveServerInput, ServerConfig, ServerSummary } from '@shared/types'
import { readJson, writeJson } from './fs-utils'
import type { SecretVault } from './secrets'

interface ServersFile {
  version: 1
  servers: ServerConfig[]
}

/** Servidores guardados en servers.json (sin secretos: esos van al SecretVault). */
export class ServerStore {
  private readonly path: string
  private file: Promise<ServersFile> | null = null

  constructor(dir: string, private readonly vault: SecretVault) {
    this.path = join(dir, 'servers.json')
  }

  async list(): Promise<ServerSummary[]> {
    const { servers } = await this.load()
    return Promise.all(servers.map(async (s) => ({ ...s, storedSecrets: await this.vault.storedKeys(s.id) })))
  }

  async get(id: string): Promise<ServerConfig> {
    const server = (await this.load()).servers.find((s) => s.id === id)
    if (!server) throw new Error('El servidor ya no existe')
    return server
  }

  async save(input: SaveServerInput): Promise<ServerSummary> {
    const file = await this.load()
    const id = input.config.id ?? randomUUID()
    const config: ServerConfig = { ...input.config, id }
    const index = file.servers.findIndex((s) => s.id === id)
    if (input.config.id && index < 0) throw new Error('El servidor ya no existe')
    if (index >= 0) file.servers[index] = config
    else file.servers.push(config)
    await this.vault.apply(id, input.secrets)
    await writeJson(this.path, file)
    return { ...config, storedSecrets: await this.vault.storedKeys(id) }
  }

  async delete(id: string): Promise<void> {
    const file = await this.load()
    file.servers = file.servers.filter((s) => s.id !== id)
    await this.vault.delete(id)
    await writeJson(this.path, file)
  }

  private load(): Promise<ServersFile> {
    // Los servidores guardados antes de que existieran los módulos no tienen el campo.
    this.file ??= readJson<ServersFile>(this.path, { version: 1, servers: [] }).then((file) => {
      file.servers = file.servers.map((s) => ({ ...s, modules: Array.isArray(s.modules) ? s.modules : [] }))
      return file
    })
    return this.file
  }
}
