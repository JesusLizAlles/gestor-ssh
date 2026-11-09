import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from './fs-utils'

interface KnownHostsFile {
  version: 1
  hosts: Record<string, string>
}

/** Huella en el mismo formato que muestra OpenSSH: `SHA256:<base64 sin relleno>`. */
export function fingerprintOf(hostKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`
}

export type HostCheck = 'trusted' | 'new' | 'changed'

/**
 * Huellas de los servidores aceptados, en known_hosts.json. Una huella nueva la confirma el
 * usuario; una que cambia se rechaza siempre (hay que olvidarla a mano).
 */
export class KnownHosts {
  private readonly path: string
  private file: Promise<KnownHostsFile> | null = null

  constructor(dir: string) {
    this.path = join(dir, 'known_hosts.json')
  }

  async check(host: string, port: number, fingerprint: string): Promise<HostCheck> {
    const known = (await this.load()).hosts[key(host, port)]
    if (!known) return 'new'
    return known === fingerprint ? 'trusted' : 'changed'
  }

  async remember(host: string, port: number, fingerprint: string): Promise<void> {
    const file = await this.load()
    file.hosts[key(host, port)] = fingerprint
    await writeJson(this.path, file)
  }

  async forget(host: string, port: number): Promise<void> {
    const file = await this.load()
    delete file.hosts[key(host, port)]
    await writeJson(this.path, file)
  }

  private load(): Promise<KnownHostsFile> {
    this.file ??= readJson<KnownHostsFile>(this.path, { version: 1, hosts: {} })
    return this.file
  }
}

const key = (host: string, port: number): string => `${host.toLowerCase()}:${port}`
