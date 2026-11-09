import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { GeoIpStatus } from '@shared/types'

// Caché de países por IP para toda la ventana: las consultas se agrupan en lotes.
const cache = new Map<string, string | null>()
const queued = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
let timer: ReturnType<typeof setTimeout> | null = null

function notify() {
  version++
  for (const listener of listeners) listener()
}

function flush() {
  timer = null
  const ips = [...queued].slice(0, 5000)
  for (const ip of ips) queued.delete(ip)
  if (!ips.length) return
  window.api.geoipLookup(ips).then(
    (result) => {
      for (const ip of ips) cache.set(ip, result[ip] ?? null)
      notify()
      if (queued.size) timer = setTimeout(flush, 0)
    },
    () => {
      for (const ip of ips) cache.set(ip, null)
      notify()
    }
  )
}

function request(ips: string[]) {
  let added = false
  for (const ip of ips) {
    if (ip && !cache.has(ip) && !queued.has(ip)) {
      queued.add(ip)
      added = true
    }
  }
  if (added && !timer) timer = setTimeout(flush, 20)
}

/** Al descargar o actualizar la base de datos, lo ya consultado deja de valer. */
function resetCache() {
  cache.clear()
  notify()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

interface GeoState {
  status: GeoIpStatus | null
  downloading: boolean
  error: string | null
  download: () => Promise<void>
}

const GeoContext = createContext<GeoState>({ status: null, downloading: false, error: null, download: async () => {} })

export function GeoProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GeoIpStatus | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.geoipStatus().then(setStatus, () => setStatus(null))
  }, [])

  const download = useCallback(async () => {
    setDownloading(true)
    setError(null)
    try {
      setStatus(await window.api.geoipDownload())
      resetCache()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDownloading(false)
    }
  }, [])

  const value = useMemo(() => ({ status, downloading, error, download }), [status, downloading, error, download])
  return <GeoContext.Provider value={value}>{children}</GeoContext.Provider>
}

export const useGeo = (): GeoState => useContext(GeoContext)

/** Países (código ISO o null) de un conjunto de IPs; se rellena según llegan las respuestas. */
export function useCountries(ips: string[]): Map<string, string | null | undefined> {
  const { status } = useGeo()
  const available = status?.available ?? false
  const key = ips.join(',')
  useEffect(() => {
    if (available) request(ips)
    // `key` resume la lista de IPs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, key])
  const current = useSyncExternalStore(subscribe, () => version)
  return useMemo(
    () => new Map(ips.map((ip) => [ip, available ? cache.get(ip) : null])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, available, current]
  )
}

const regionNames = new Intl.DisplayNames(['es'], { type: 'region' })
const isWindows = navigator.platform.toLowerCase().startsWith('win')

export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Bandera con los indicadores regionales de Unicode (Windows no los dibuja como banderas: ahí no se ponen). */
export function flag(code: string): string {
  if (isWindows || !/^[A-Z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

/** País de una IP: bandera y nombre. Nada si no hay base de datos o la IP es privada. */
export function Country({ ip }: { ip: string }) {
  const countries = useCountries([ip])
  const code = countries.get(ip)
  if (!code) return null
  return (
    <span className="country" title={`${countryName(code)} (${code})`}>
      {flag(code) && <span className="flag">{flag(code)}</span>}
      {countryName(code)}
    </span>
  )
}
