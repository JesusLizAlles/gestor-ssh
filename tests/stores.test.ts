import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SaveServerInput } from '@shared/types'
import { fingerprintOf, KnownHosts } from '../src/main/store/known-hosts'
import { SecretVault } from '../src/main/store/secrets'
import { ServerStore } from '../src/main/store/servers'
import { fakeCipher, tempDir } from './helpers'

const input = (overrides: Partial<SaveServerInput['config']> = {}): SaveServerInput => ({
  config: {
    name: 'Web',
    host: 'web.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    privateKeyPath: '',
    environment: 'prod',
    initialPath: '/var/www',
    ...overrides
  },
  secrets: { password: 'muy-secreta' }
})

describe('ServerStore', () => {
  it('guarda servidores sin secretos en claro y con permisos 0600', async () => {
    const dir = await tempDir()
    const vault = new SecretVault(dir, fakeCipher())
    const store = new ServerStore(dir, vault)
    const saved = await store.save(input())
    expect(saved.storedSecrets).toEqual(['password'])
    const servers = await readFile(join(dir, 'servers.json'), 'utf8')
    const secrets = await readFile(join(dir, 'secrets.json'), 'utf8')
    expect(servers).not.toContain('muy-secreta')
    expect(secrets).not.toContain('muy-secreta')
    expect((await stat(join(dir, 'secrets.json'))).mode & 0o777).toBe(0o600)
    expect(await vault.get(saved.id)).toEqual({ password: 'muy-secreta' })

    // Al releer desde disco sale lo mismo.
    const again = new ServerStore(dir, new SecretVault(dir, fakeCipher()))
    expect((await again.list()).map((s) => s.name)).toEqual(['Web'])
  })

  it('edita conservando o borrando secretos, y elimina', async () => {
    const dir = await tempDir()
    const vault = new SecretVault(dir, fakeCipher())
    const store = new ServerStore(dir, vault)
    const saved = await store.save(input())
    await store.save({ config: { ...input().config, id: saved.id, name: 'Web 2' } })
    expect(await vault.get(saved.id)).toEqual({ password: 'muy-secreta' })
    await store.save({ config: { ...input().config, id: saved.id, authMethod: 'agent' }, secrets: { password: null } })
    expect(await vault.get(saved.id)).toEqual({})
    await store.delete(saved.id)
    expect(await store.list()).toEqual([])
    await expect(store.save({ config: { ...input().config, id: 'no-existe' } })).rejects.toThrow('ya no existe')
  })

  it('sin llavero, los secretos solo viven en memoria', async () => {
    const dir = await tempDir()
    const vault = new SecretVault(dir, fakeCipher(false))
    const saved = await new ServerStore(dir, vault).save(input())
    expect(await vault.get(saved.id)).toEqual({ password: 'muy-secreta' })
    await expect(readFile(join(dir, 'secrets.json'))).rejects.toThrow()
  })
})

describe('KnownHosts', () => {
  it('nuevo, conocido, cambiado y olvidado', async () => {
    const hosts = new KnownHosts(await tempDir())
    const fp = fingerprintOf(Buffer.from('clave'))
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(await hosts.check('Web.example.com', 22, fp)).toBe('new')
    await hosts.remember('Web.example.com', 22, fp)
    expect(await hosts.check('web.example.com', 22, fp)).toBe('trusted')
    expect(await hosts.check('web.example.com', 22, 'SHA256:otra')).toBe('changed')
    expect(await hosts.check('web.example.com', 2222, fp)).toBe('new')
    await hosts.forget('web.example.com', 22)
    expect(await hosts.check('web.example.com', 22, fp)).toBe('new')
  })
})
