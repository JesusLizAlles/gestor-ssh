import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { basename as localBasename, dirname as localDirname, join as localJoin } from 'node:path'
import { basename, join } from '@shared/remote-path'
import type { TransferDirection, TransferInfo } from '@shared/types'
import type { ServerSession } from './ssh/sessions'
import { entryType, type Sftp } from './ssh/sftp'

interface FileStep {
  from: string
  to: string
  size: number
  mode?: number
}

interface Plan {
  dirs: string[]
  files: FileStep[]
}

interface Job {
  info: TransferInfo
  session: ServerSession
  /** Fichero o carpeta local (destino de una descarga u origen de una subida). */
  localPath: string
  /** Origen remoto de una descarga o carpeta remota de destino de una subida. */
  remotePath: string
  sftp: Sftp | null
  cancelled: boolean
}

export interface TransferDeps {
  emit: (info: TransferInfo) => void
  concurrency?: number
}

/** Cola de descargas y subidas por SFTP, con progreso y cancelación. */
export class TransferManager {
  private readonly jobs = new Map<string, Job>()
  private readonly queue: Job[] = []
  private running = 0
  private readonly lastEmit = new Map<string, number>()

  constructor(private readonly deps: TransferDeps) {}

  list(): TransferInfo[] {
    return [...this.jobs.values()].map((j) => ({ ...j.info }))
  }

  /** Descarga `remotePath` (fichero o carpeta) a `localPath` (ruta final del fichero o carpeta). */
  download(session: ServerSession, remotePath: string, localPath: string): TransferInfo {
    return this.enqueue('download', session, remotePath, localPath, localBasename(localPath), localDirname(localPath))
  }

  /** Sube `localPath` (fichero o carpeta) dentro de la carpeta remota `remoteDir`. */
  upload(session: ServerSession, localPath: string, remoteDir: string): TransferInfo {
    return this.enqueue('upload', session, remoteDir, localPath, localBasename(localPath), remoteDir)
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job || (job.info.state !== 'queued' && job.info.state !== 'running')) return
    job.cancelled = true
    if (job.info.state === 'queued') {
      this.queue.splice(this.queue.indexOf(job), 1)
      this.finish(job, 'cancelled', null)
      return
    }
    // Cerrar el canal hace fallar la operación en curso; run() lo trata como cancelación.
    job.sftp?.end()
  }

  /** Cancela todo lo pendiente de un servidor (al desconectarlo). */
  cancelServer(serverId: string): void {
    for (const job of this.jobs.values()) if (job.info.serverId === serverId) this.cancel(job.info.id)
  }

  clearFinished(): void {
    for (const [id, job] of this.jobs) {
      if (job.info.state !== 'queued' && job.info.state !== 'running') this.jobs.delete(id)
    }
  }

  /** Ruta local de una descarga terminada, para enseñarla en el explorador de archivos. */
  localPathOf(id: string): string | null {
    const job = this.jobs.get(id)
    return job && job.info.direction === 'download' && job.info.state === 'done' ? job.localPath : null
  }

  /** Espera a que no quede nada en marcha (para los tests). */
  async idle(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) await new Promise((r) => setTimeout(r, 20))
  }

  private enqueue(
    direction: TransferDirection,
    session: ServerSession,
    remotePath: string,
    localPath: string,
    name: string,
    destination: string
  ): TransferInfo {
    const info: TransferInfo = {
      id: randomUUID(),
      serverId: session.config.id,
      serverName: session.config.name,
      direction,
      name: direction === 'download' ? basename(remotePath) : name,
      destination,
      totalBytes: 0,
      doneBytes: 0,
      totalFiles: 0,
      doneFiles: 0,
      state: 'queued',
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    const job: Job = { info, session, localPath, remotePath, sftp: null, cancelled: false }
    this.jobs.set(info.id, job)
    this.queue.push(job)
    this.emit(job, true)
    this.pump()
    return { ...info }
  }

  private pump(): void {
    const limit = this.deps.concurrency ?? 3
    while (this.running < limit && this.queue.length) {
      const job = this.queue.shift()!
      this.running++
      void this.run(job).finally(() => {
        this.running--
        this.pump()
      })
    }
  }

  private async run(job: Job): Promise<void> {
    job.info.state = 'running'
    job.info.startedAt = Date.now()
    this.emit(job, true)
    let current: FileStep | null = null
    try {
      job.sftp = await job.session.dedicatedSftp()
      if (job.cancelled) throw new Error('cancelled')
      const plan = job.info.direction === 'download' ? await this.planDownload(job) : await this.planUpload(job)
      job.info.totalBytes = plan.files.reduce((sum, f) => sum + f.size, 0)
      job.info.totalFiles = plan.files.length
      this.emit(job, true)
      for (const dir of plan.dirs) {
        if (job.info.direction === 'download') await mkdir(dir, { recursive: true })
        else if (!(await job.sftp.exists(dir))) await job.sftp.mkdir(dir)
      }
      for (const file of plan.files) {
        if (job.cancelled) throw new Error('cancelled')
        current = file
        await this.copy(job, file)
        current = null
        job.info.doneFiles++
        this.emit(job, true)
      }
      this.finish(job, 'done', null)
    } catch (err) {
      if (current) await this.removePartial(job, current)
      if (job.cancelled) this.finish(job, 'cancelled', null)
      else this.finish(job, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      job.sftp?.end()
      job.sftp = null
    }
  }

  private copy(job: Job, file: FileStep): Promise<void> {
    const sftp = job.sftp!
    const base = job.info.doneBytes
    const step = (transferred: number) => {
      job.info.doneBytes = base + transferred
      this.emit(job, false)
    }
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error | null) => {
        if (err) return reject(job.cancelled ? new Error('cancelled') : new Error(`${err.message} (${file.from})`))
        job.info.doneBytes = base + file.size
        resolve()
      }
      const options = { step, ...(file.mode !== undefined ? { mode: file.mode } : {}) }
      if (job.info.direction === 'download') sftp.raw.fastGet(file.from, file.to, options, done)
      else sftp.raw.fastPut(file.from, file.to, options, done)
    })
  }

  /** Recorre el origen remoto. Los enlaces a ficheros se descargan; los enlaces a carpetas no se siguen. */
  private async planDownload(job: Job): Promise<Plan> {
    const sftp = job.sftp!
    // Se conservan los permisos (sobre todo el de ejecución), salvo en Windows, donde no significan nada.
    const modeOf = (mode: number) => (process.platform === 'win32' ? undefined : mode & 0o777)
    const root = await sftp.stat(job.remotePath)
    if (entryType(root.mode) !== 'dir') {
      return { dirs: [], files: [{ from: job.remotePath, to: job.localPath, size: root.size, mode: modeOf(root.mode) }] }
    }
    const plan: Plan = { dirs: [job.localPath], files: [] }
    const walk = async (remote: string, local: string): Promise<void> => {
      for (const item of await sftp.readdirRaw(remote)) {
        if (item.filename === '.' || item.filename === '..') continue
        if (job.cancelled) throw new Error('cancelled')
        const from = join(remote, item.filename)
        const to = localJoin(local, safeLocalName(item.filename))
        let type = entryType(item.attrs.mode)
        let { size, mode } = item.attrs
        if (type === 'link') {
          const target = await sftp.stat(from).catch(() => null)
          if (!target || entryType(target.mode) !== 'file') continue
          type = 'file'
          size = target.size
          mode = target.mode
        }
        if (type === 'dir') {
          plan.dirs.push(to)
          await walk(from, to)
        } else if (type === 'file') plan.files.push({ from, to, size, mode: modeOf(mode) })
      }
    }
    await walk(job.remotePath, job.localPath)
    return plan
  }

  /** Recorre el origen local. Los enlaces a carpetas no se siguen (evita bucles). */
  private async planUpload(job: Job): Promise<Plan> {
    const keepMode = process.platform !== 'win32'
    const root = await stat(job.localPath)
    const target = join(job.remotePath, job.info.name)
    if (!root.isDirectory()) {
      return { dirs: [], files: [{ from: job.localPath, to: target, size: root.size, mode: keepMode ? root.mode & 0o777 : undefined }] }
    }
    const plan: Plan = { dirs: [target], files: [] }
    const walk = async (local: string, remote: string): Promise<void> => {
      for (const item of await readdir(local, { withFileTypes: true })) {
        if (job.cancelled) throw new Error('cancelled')
        const from = localJoin(local, item.name)
        const to = join(remote, item.name)
        const linkStat = item.isSymbolicLink() ? await stat(from).catch(() => null) : null
        if (item.isDirectory()) {
          plan.dirs.push(to)
          await walk(from, to)
        } else if (item.isFile() || linkStat?.isFile()) {
          const s = linkStat ?? (await lstat(from))
          plan.files.push({ from, to, size: s.size, mode: keepMode ? s.mode & 0o777 : undefined })
        }
      }
    }
    await walk(job.localPath, target)
    return plan
  }

  /** Lo que quedó a medias no sirve: se borra (en local o en el servidor). */
  private async removePartial(job: Job, file: FileStep): Promise<void> {
    try {
      if (job.info.direction === 'download') await unlink(file.to)
      else await (await job.session.sftp()).unlink(file.to)
    } catch {
      // Si no se llegó a crear, o ya no hay conexión, no hay nada que hacer.
    }
  }

  private finish(job: Job, state: TransferInfo['state'], error: string | null): void {
    job.info.state = state
    job.info.error = error
    job.info.finishedAt = Date.now()
    this.emit(job, true)
  }

  /** Los cambios de estado se mandan siempre; el progreso, como mucho cada 150 ms. */
  private emit(job: Job, force: boolean): void {
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(job.info.id) ?? 0) < 150) return
    this.lastEmit.set(job.info.id, now)
    this.deps.emit({ ...job.info })
  }
}

/** Nombres remotos que no valen en Windows (`:`, `?`…) se adaptan al descargarlos. */
export function safeLocalName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return name
  const cleaned = name.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_')
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned
}
