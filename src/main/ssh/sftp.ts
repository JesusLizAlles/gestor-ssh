import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import { join } from '@shared/remote-path'
import type { DirListing, EntryType, RemoteEntry } from '@shared/types'

// Bits de tipo de st_mode (iguales en todos los Unix).
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

export function entryType(mode: number): EntryType {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir'
    case S_IFREG:
      return 'file'
    case S_IFLNK:
      return 'link'
    default:
      return 'other'
  }
}

/** Códigos de estado de SFTP (draft-ietf-secsh-filexfer-02) que interesan. */
const SFTP_NO_SUCH_FILE = 2
const SFTP_PERMISSION_DENIED = 3

/** Traduce los errores de SFTP a mensajes legibles, con la ruta afectada. */
export function sftpError(err: unknown, path: string): Error {
  const code = (err as { code?: number }).code
  if (code === SFTP_NO_SUCH_FILE) return new Error(`No existe: ${path}`)
  if (code === SFTP_PERMISSION_DENIED) return new Error(`Permiso denegado: ${path}`)
  const message = err instanceof Error ? err.message : String(err)
  return new Error(`${message} (${path})`)
}

export function isNotFound(err: unknown): boolean {
  return (err as { code?: number }).code === SFTP_NO_SUCH_FILE
}

export function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(new Error(`El servidor no permite SFTP: ${err.message}`))
      else resolve(sftp)
    })
  })
}

/** Envoltorios con promesas sobre un canal SFTP. */
export class Sftp {
  constructor(readonly raw: SFTPWrapper) {}

  realpath(path: string): Promise<string> {
    return new Promise((resolve, reject) =>
      this.raw.realpath(path, (err, abs) => (err ? reject(sftpError(err, path)) : resolve(abs)))
    )
  }

  stat(path: string): Promise<Stats> {
    return new Promise((resolve, reject) => this.raw.stat(path, (err, s) => (err ? reject(sftpError(err, path)) : resolve(s))))
  }

  lstat(path: string): Promise<Stats> {
    return new Promise((resolve, reject) => this.raw.lstat(path, (err, s) => (err ? reject(sftpError(err, path)) : resolve(s))))
  }

  /** ¿Existe la ruta (sin seguir enlaces)? */
  async exists(path: string): Promise<boolean> {
    try {
      await new Promise<void>((resolve, reject) => this.raw.lstat(path, (err) => (err ? reject(err) : resolve())))
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw sftpError(err, path)
    }
  }

  readdirRaw(path: string): Promise<FileEntryWithStats[]> {
    return new Promise((resolve, reject) =>
      this.raw.readdir(path, (err, list) => (err ? reject(sftpError(err, path)) : resolve(list)))
    )
  }

  /** Contenido de una carpeta, con los enlaces simbólicos resueltos y ordenado (carpetas primero). */
  async listDir(path: string): Promise<DirListing> {
    const abs = await this.realpath(path)
    const raw = await this.readdirRaw(abs)
    const entries = await Promise.all(
      raw
        .filter((item) => item.filename !== '.' && item.filename !== '..')
        .map(async (item): Promise<RemoteEntry> => {
          const a = item.attrs
          const entry: RemoteEntry = {
            name: item.filename,
            path: join(abs, item.filename),
            type: entryType(a.mode),
            size: a.size,
            mtime: a.mtime * 1000,
            mode: a.mode & 0o7777,
            uid: a.uid,
            gid: a.gid,
            ...ownerFromLongname(item.longname, a.uid, a.gid)
          }
          if (entry.type === 'link') {
            // Un enlace roto o sin permisos se queda como enlace a secas.
            entry.linkTarget = await this.stat(entry.path).then(
              (s) => entryType(s.mode),
              () => undefined
            )
          }
          return entry
        })
    )
    entries.sort(compareEntries)
    return { path: abs, entries }
  }

  mkdir(path: string): Promise<void> {
    return new Promise((resolve, reject) => this.raw.mkdir(path, (err) => (err ? reject(sftpError(err, path)) : resolve())))
  }

  rename(from: string, to: string): Promise<void> {
    return new Promise((resolve, reject) => this.raw.rename(from, to, (err) => (err ? reject(sftpError(err, from)) : resolve())))
  }

  unlink(path: string): Promise<void> {
    return new Promise((resolve, reject) => this.raw.unlink(path, (err) => (err ? reject(sftpError(err, path)) : resolve())))
  }

  rmdir(path: string): Promise<void> {
    return new Promise((resolve, reject) => this.raw.rmdir(path, (err) => (err ? reject(sftpError(err, path)) : resolve())))
  }

  /** Borra un fichero, un enlace o una carpeta con todo su contenido. Los enlaces no se siguen. */
  async removeRecursive(path: string): Promise<void> {
    const s = await this.lstat(path)
    if (entryType(s.mode) !== 'dir') return this.unlink(path)
    for (const item of await this.readdirRaw(path)) {
      if (item.filename === '.' || item.filename === '..') continue
      await this.removeRecursive(join(path, item.filename))
    }
    await this.rmdir(path)
  }

  readFile(path: string): Promise<Buffer> {
    return new Promise((resolve, reject) =>
      this.raw.readFile(path, (err: Error | undefined, data: Buffer) => (err ? reject(sftpError(err, path)) : resolve(data)))
    )
  }

  /** Escribe en el mismo fichero (conserva propietario y permisos); lo crea si no existe. */
  writeFile(path: string, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) =>
      this.raw.writeFile(path, data, (err) => (err ? reject(sftpError(err, path)) : resolve()))
    )
  }

  /** Crea un fichero vacío; falla si ya existe. */
  createExclusive(path: string): Promise<void> {
    return new Promise((resolve, reject) =>
      this.raw.open(path, 'wx', (err, handle) => {
        if (err) return reject(sftpError(err, path))
        this.raw.close(handle, (closeErr) => (closeErr ? reject(sftpError(closeErr, path)) : resolve()))
      })
    )
  }

  end(): void {
    this.raw.end()
  }
}

/**
 * `longname` es la línea de `ls -l` que manda el servidor: «-rw-r--r--  1 www-data www-data 1234 …».
 * No está normalizada, así que si no tiene esa forma se usan los números.
 */
export function ownerFromLongname(longname: string, uid: number, gid: number): { owner: string; group: string } {
  const fields = longname.trim().split(/\s+/)
  if (fields.length >= 5 && /^[-dlcbps?][-rwxsStT]{9}/.test(fields[0] ?? '') && /^\d+$/.test(fields[1] ?? '')) {
    return { owner: fields[2]!, group: fields[3]! }
  }
  return { owner: String(uid), group: String(gid) }
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' })

/** Carpetas (y enlaces a carpetas) primero; después por nombre, con orden natural. */
export function compareEntries(a: RemoteEntry, b: RemoteEntry): number {
  const isDir = (e: RemoteEntry) => e.type === 'dir' || (e.type === 'link' && e.linkTarget === 'dir')
  if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1
  return collator.compare(a.name, b.name)
}
