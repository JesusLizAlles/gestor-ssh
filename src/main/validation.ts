import { z } from 'zod'

export const idSchema = z.string().min(1).max(100)
export const uuidSchema = z.uuid()

/** Ruta remota absoluta o relativa a la carpeta personal (se resuelve en el servidor). */
export const remotePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'ruta no válida')

export const remotePathsSchema = z.array(remotePathSchema).min(1).max(1000)

const secretValue = z.string().max(10_000).nullable().optional()

export const saveServerSchema = z.object({
  config: z.object({
    id: idSchema.optional(),
    name: z.string().trim().min(1, 'pon un nombre').max(100),
    host: z
      .string()
      .trim()
      .min(1, 'falta el servidor')
      .max(255)
      .refine((h) => !/\s/.test(h), 'el servidor no puede tener espacios'),
    port: z.number().int().min(1).max(65535),
    username: z.string().trim().min(1, 'falta el usuario').max(255),
    authMethod: z.enum(['password', 'privateKey', 'agent']),
    privateKeyPath: z.string().max(4096),
    environment: z.enum(['dev', 'test', 'prod']),
    initialPath: z.string().max(4096)
  }),
  secrets: z.object({ password: secretValue, passphrase: secretValue }).optional()
})

export const saveFileSchema = z.object({
  serverId: idSchema,
  path: remotePathSchema,
  content: z.string().max(20 * 1024 * 1024),
  expectedMtime: z.number().nullable()
})

export const terminalSizeSchema = z.number().int().min(1).max(1000)
export const uploadKindSchema = z.enum(['files', 'folder'])
export const uploadModeSchema = z.enum(['overwrite', 'skip'])
