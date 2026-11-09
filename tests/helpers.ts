import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretCipher } from '../src/main/store/secrets'

export const tempDir = (prefix = 'gestor-ssh-test-'): Promise<string> => mkdtemp(join(tmpdir(), prefix))

/** Cifrado falso y reversible para probar el almacén sin llavero del sistema. */
export const fakeCipher = (persistent = true): SecretCipher => ({
  status: async () => ({ persistent, backend: 'test' }),
  encrypt: async (plain) => Buffer.from(`enc:${plain}`),
  decrypt: async (data) => ({ value: data.toString().replace(/^enc:/, ''), reencrypt: false })
})
