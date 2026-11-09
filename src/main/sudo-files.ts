import { randomUUID } from 'node:crypto'
import { formatSize, looksLikeText } from '@shared/format'
import { shellQuote as q } from '@shared/shell'
import { FILE_CHANGED_ERROR, MAX_EDIT_BYTES, type RemoteFile } from '@shared/types'
import { outputText, runScript } from './ssh/commands'
import type { ServerSession } from './ssh/sessions'

/** Tamaño, fecha (s) y tipo con `stat` (GNU o BusyBox). */
async function sudoStat(session: ServerSession, path: string): Promise<{ size: number; mtime: number; regular: boolean } | null> {
  const result = await runScript(session, `stat -c '%s %Y %F' -- ${q(path)}`, { sudo: true })
  if (result.code !== 0) {
    if (/No such file/i.test(result.stderr)) return null
    throw new Error(outputText(result) || `No se pudo consultar ${path}`)
  }
  const [size, mtime, ...type] = result.stdout.toString('utf8').trim().split(' ')
  return { size: Number(size), mtime: Number(mtime) * 1000, regular: type.join(' ').startsWith('regular') }
}

/** Lee un fichero de texto como root. */
export async function sudoReadText(session: ServerSession, path: string): Promise<RemoteFile> {
  const info = await sudoStat(session, path)
  if (!info) throw new Error(`No existe: ${path}`)
  if (!info.regular) throw new Error('Solo se pueden abrir ficheros')
  if (info.size > MAX_EDIT_BYTES) {
    throw new Error(`El fichero ocupa ${formatSize(info.size)}; el editor admite hasta ${formatSize(MAX_EDIT_BYTES)}.`)
  }
  const result = await runScript(session, `cat -- ${q(path)}`, { sudo: true, maxBytes: MAX_EDIT_BYTES + 1 })
  if (result.code !== 0) throw new Error(outputText(result) || `No se pudo leer ${path}`)
  if (!looksLikeText(result.stdout)) throw new Error('Parece un fichero binario (o no está en UTF-8): descárgalo para abrirlo')
  return { path, content: result.stdout.toString('utf8'), size: result.stdout.length, mtime: info.mtime }
}

/**
 * Escribe un fichero como root sin cambiar su propietario ni sus permisos: el contenido se sube
 * por SFTP a un temporal propio (0600) y `sudo` lo vuelca encima del fichero (`cat tmp > destino`).
 * La entrada estándar de sudo queda solo para la contraseña.
 */
export async function sudoWriteText(
  session: ServerSession,
  path: string,
  content: string,
  expectedMtime: number | null
): Promise<{ mtime: number; size: number }> {
  if (expectedMtime !== null) {
    const current = await sudoStat(session, path)
    if (current && current.mtime !== expectedMtime) throw new Error(FILE_CHANGED_ERROR)
  }
  const sftp = await session.sftp()
  const tmp = `/tmp/.gestor-ssh-${randomUUID()}`
  await new Promise<void>((resolve, reject) =>
    sftp.raw.writeFile(tmp, Buffer.from(content, 'utf8'), { mode: 0o600, flag: 'wx' }, (err) => (err ? reject(err) : resolve()))
  )
  try {
    const result = await runScript(session, `cat -- ${q(tmp)} > ${q(path)}`, { sudo: true })
    if (result.code !== 0) throw new Error(outputText(result) || `No se pudo escribir ${path}`)
  } finally {
    await sftp.unlink(tmp).catch(() => {})
  }
  const after = await sudoStat(session, path)
  return { mtime: after?.mtime ?? Date.now(), size: after?.size ?? Buffer.byteLength(content) }
}
