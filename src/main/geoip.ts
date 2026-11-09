import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip as gunzipCallback } from 'node:zlib'
import { Reader, type CountryResponse } from 'mmdb-lib'
import { isLoopback, isMulticast, isPrivate } from '@shared/security'
import type { GeoIpStatus } from '@shared/types'

const gunzip = promisify(gunzipCallback)

/** Base de datos gratuita de DB-IP (CC BY 4.0): se publica el día 1 de cada mes. */
export const dbipUrl = (year: number, month: number): string =>
  `https://download.db-ip.com/free/dbip-country-lite-${year}-${String(month).padStart(2, '0')}.mmdb.gz`

/** El mes actual y el anterior (a primeros de mes puede que aún no esté publicada la nueva). */
export function candidateUrls(now: Date): string[] {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  const previous = month === 1 ? [year - 1, 12] : [year, month - 1]
  return [dbipUrl(year, month), dbipUrl(previous[0]!, previous[1]!)]
}

/** A partir de cuántos días se sugiere actualizarla. */
const OUTDATED_DAYS = 45
const MAX_DOWNLOAD = 64 * 1024 * 1024

type CountryRecord = CountryResponse
type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>

/**
 * País de cada IP con la base de datos «IP to Country Lite» de DB-IP, descargada en este equipo.
 * Las consultas son locales: las IPs no se mandan a ningún servicio.
 */
export class GeoIp {
  private readonly path: string
  private reader: Promise<Reader<CountryRecord> | null> | null = null

  constructor(
    dir: string,
    private readonly fetchFn: FetchLike,
    private readonly now: () => Date = () => new Date()
  ) {
    this.path = join(dir, 'geoip', 'dbip-country-lite.mmdb')
  }

  async status(): Promise<GeoIpStatus> {
    const reader = await this.load()
    if (!reader) return { available: false, builtAt: null, sizeBytes: 0, outdated: false }
    const builtAt = reader.metadata.buildEpoch.getTime()
    const size = await stat(this.path).then((s) => s.size, () => 0)
    return { available: true, builtAt, sizeBytes: size, outdated: this.now().getTime() - builtAt > OUTDATED_DAYS * 86_400_000 }
  }

  /** Descarga la versión más reciente, la comprueba y sustituye a la que hubiera. */
  async download(): Promise<GeoIpStatus> {
    let lastError = ''
    for (const url of candidateUrls(this.now())) {
      let response: Awaited<ReturnType<FetchLike>>
      try {
        response = await this.fetchFn(url)
      } catch (err) {
        lastError = `No se pudo conectar con db-ip.com: ${(err as Error).message}`
        continue
      }
      if (!response.ok) {
        lastError = `db-ip.com respondió ${response.status}`
        continue
      }
      const compressed = Buffer.from(await response.arrayBuffer())
      if (compressed.length > MAX_DOWNLOAD) throw new Error('La descarga es demasiado grande; no parece la base de datos esperada')
      let data: Buffer
      try {
        data = await gunzip(compressed, { maxOutputLength: 4 * MAX_DOWNLOAD })
      } catch {
        throw new Error('El fichero descargado no es válido (no es gzip)')
      }
      const reader = validate(data)
      await mkdir(join(this.path, '..'), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, data)
      await rename(tmp, this.path)
      this.reader = Promise.resolve(reader)
      return this.status()
    }
    throw new Error(lastError || 'No se pudo descargar la base de datos de países')
  }

  /** Código ISO del país de cada IP (null si es privada, desconocida o no hay base de datos). */
  async lookup(ips: string[]): Promise<Record<string, string | null>> {
    const reader = await this.load()
    const out: Record<string, string | null> = {}
    for (const ip of ips) {
      if (!reader || !isIP(ip) || isPrivate(ip) || isLoopback(ip) || isMulticast(ip)) {
        out[ip] = null
        continue
      }
      try {
        out[ip] = reader.get(ip)?.country?.iso_code ?? null
      } catch {
        out[ip] = null
      }
    }
    return out
  }

  private load(): Promise<Reader<CountryRecord> | null> {
    this.reader ??= readFile(this.path).then(
      (data) => {
        try {
          return validate(data)
        } catch {
          return null
        }
      },
      () => null
    )
    return this.reader
  }
}

/** Comprueba que es una base de datos de países que responde a una IP conocida. */
function validate(data: Buffer): Reader<CountryRecord> {
  let reader: Reader<CountryRecord>
  try {
    reader = new Reader<CountryRecord>(data)
  } catch {
    throw new Error('El fichero descargado no es una base de datos MMDB válida')
  }
  if (!/country/i.test(reader.metadata.databaseType) || !reader.get('8.8.8.8')?.country?.iso_code) {
    throw new Error('La base de datos descargada no tiene países')
  }
  return reader
}
