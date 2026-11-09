import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { candidateUrls, GeoIp } from '../src/main/geoip'
import { tempDir } from './helpers'

const response = (status: number, body: Buffer = Buffer.alloc(0)) => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
})

describe('base de datos de países', () => {
  it('prueba el mes actual y el anterior (también al cambiar de año)', () => {
    expect(candidateUrls(new Date('2026-11-09T10:00:00Z'))).toEqual([
      'https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz',
      'https://download.db-ip.com/free/dbip-country-lite-2026-10.mmdb.gz'
    ])
    expect(candidateUrls(new Date('2027-01-01T03:00:00Z'))[1]).toBe('https://download.db-ip.com/free/dbip-country-lite-2026-12.mmdb.gz')
  })

  it('sin base de datos: no disponible y ninguna IP tiene país', async () => {
    const geo = new GeoIp(await tempDir(), async () => response(404))
    expect(await geo.status()).toEqual({ available: false, builtAt: null, sizeBytes: 0, outdated: false })
    expect(await geo.lookup(['8.8.8.8', '192.168.1.1'])).toEqual({ '8.8.8.8': null, '192.168.1.1': null })
  })

  it('errores de descarga claros: 404, sin red, no es gzip, no es una base de datos', async () => {
    const urls: string[] = []
    const notFound = new GeoIp(await tempDir(), async (url) => {
      urls.push(url)
      return response(404)
    })
    await expect(notFound.download()).rejects.toThrow('db-ip.com respondió 404')
    expect(urls).toHaveLength(2)

    const offline = new GeoIp(await tempDir(), async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    await expect(offline.download()).rejects.toThrow(/No se pudo conectar con db-ip.com/)

    const notGzip = new GeoIp(await tempDir(), async () => response(200, Buffer.from('<html>')))
    await expect(notGzip.download()).rejects.toThrow(/no es gzip/)

    const notMmdb = new GeoIp(await tempDir(), async () => response(200, gzipSync(Buffer.from('esto no es mmdb'))))
    await expect(notMmdb.download()).rejects.toThrow(/no es una base de datos MMDB/)
  })

  // Descarga de verdad (unos 4 MB de db-ip.com): solo si se pide, para no depender de la red en CI.
  it.skipIf(!process.env.GEOIP_NETWORK)('descarga la base real y resuelve países en local', async () => {
    const dir = await tempDir()
    const geo = new GeoIp(dir, (url) => fetch(url))
    const status = await geo.download()
    expect(status.available).toBe(true)
    expect(status.outdated).toBe(false)
    expect(status.sizeBytes).toBeGreaterThan(1_000_000)
    expect(await geo.lookup(['8.8.8.8', '2a00:1450:4003::1', '10.0.0.1', '127.0.0.1', 'no-ip', '224.0.0.251'])).toEqual({
      '8.8.8.8': 'US',
      '2a00:1450:4003::1': expect.stringMatching(/^[A-Z]{2}$/),
      '10.0.0.1': null,
      '127.0.0.1': null,
      'no-ip': null,
      '224.0.0.251': null
    })
    // Otra instancia (como al reabrir la app) la lee del disco.
    const again = new GeoIp(dir, async () => response(500))
    expect((await again.status()).available).toBe(true)
    expect((await again.lookup(['8.8.8.8']))['8.8.8.8']).toBe('US')
  }, 60_000)
})
