import { join } from 'node:path'
import type { SecretKey, SecretsPatch, SecretStorageStatus } from '@shared/types'
import { readJson, writeJson } from './fs-utils'

/** Cifrado del sistema. En la app es safeStorage de Electron; en los tests, uno falso. */
export interface SecretCipher {
  status(): Promise<SecretStorageStatus>
  encrypt(plain: string): Promise<Buffer>
  /** `reencrypt` = la clave del sistema rotó y conviene volver a cifrar el valor. */
  decrypt(data: Buffer): Promise<{ value: string; reencrypt: boolean }>
}

export type Secrets = Partial<Record<SecretKey, string>>

interface SecretsFile {
  version: 1
  entries: Record<string, Secrets>
}

/**
 * Contraseñas y frases de paso cifradas con el llavero del sistema, en secrets.json.
 * Sin llavero real, viven solo en memoria mientras la app está abierta.
 */
export class SecretVault {
  private readonly path: string
  private readonly memory = new Map<string, Secrets>()
  private file: Promise<SecretsFile> | null = null
  private cachedStatus: Promise<SecretStorageStatus> | null = null

  constructor(dir: string, private readonly cipher: SecretCipher) {
    this.path = join(dir, 'secrets.json')
  }

  status(): Promise<SecretStorageStatus> {
    this.cachedStatus ??= this.cipher.status()
    return this.cachedStatus
  }

  async get(id: string): Promise<Secrets> {
    if (!(await this.status()).persistent) return { ...this.memory.get(id) }
    const file = await this.load()
    const entry = file.entries[id] ?? {}
    const out: Secrets = {}
    let rotated = false
    for (const [key, value] of Object.entries(entry) as [SecretKey, string][]) {
      const { value: plain, reencrypt } = await this.cipher.decrypt(Buffer.from(value, 'base64'))
      out[key] = plain
      if (reencrypt) {
        entry[key] = (await this.cipher.encrypt(plain)).toString('base64')
        rotated = true
      }
    }
    if (rotated) await writeJson(this.path, file)
    return out
  }

  async storedKeys(id: string): Promise<SecretKey[]> {
    if (!(await this.status()).persistent) return Object.keys(this.memory.get(id) ?? {}) as SecretKey[]
    return Object.keys((await this.load()).entries[id] ?? {}) as SecretKey[]
  }

  async apply(id: string, patch: SecretsPatch | undefined): Promise<void> {
    if (!patch) return
    const persistent = (await this.status()).persistent
    const file = persistent ? await this.load() : null
    const entry: Secrets = { ...(file ? file.entries[id] : this.memory.get(id)) }
    for (const [key, value] of Object.entries(patch) as [SecretKey, string | null | undefined][]) {
      if (value === null) delete entry[key]
      else if (typeof value === 'string') entry[key] = file ? (await this.cipher.encrypt(value)).toString('base64') : value
    }
    if (!file) {
      this.memory.set(id, entry)
      return
    }
    file.entries[id] = entry
    await writeJson(this.path, file)
  }

  async delete(id: string): Promise<void> {
    this.memory.delete(id)
    if (!(await this.status()).persistent) return
    const file = await this.load()
    delete file.entries[id]
    await writeJson(this.path, file)
  }

  private load(): Promise<SecretsFile> {
    this.file ??= readJson<SecretsFile>(this.path, { version: 1, entries: {} })
    return this.file
  }
}
