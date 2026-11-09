import type { EntryType } from './types'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Tamaño legible en base 1024: 0 B, 512 B, 1,5 KB, 23 MB… */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toLocaleString('es-ES', { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${UNITS[unit]}`
}

/** Permisos como los enseña `ls -l`: drwxr-xr-x. */
export function formatMode(mode: number, type: EntryType): string {
  const prefix = type === 'dir' ? 'd' : type === 'link' ? 'l' : type === 'other' ? '?' : '-'
  const bit = (mask: number, char: string) => (mode & mask ? char : '-')
  const exec = (mask: number, special: number, set: string, unset: string) =>
    mode & special ? (mode & mask ? set : unset) : bit(mask, 'x')
  return (
    prefix +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    exec(0o100, 0o4000, 's', 'S') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    exec(0o010, 0o2000, 's', 'S') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    exec(0o001, 0o1000, 't', 'T')
  )
}

/** Octal de 3 o 4 cifras: 755, 2775… */
export function formatOctal(mode: number): string {
  const value = mode & 0o7777
  return value > 0o777 ? value.toString(8).padStart(4, '0') : value.toString(8).padStart(3, '0')
}

export function formatDate(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Velocidad o resto de una transferencia: «2,3 MB/s». */
export function formatRate(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`
}

/** ¿Parece texto? Sin bytes NUL en el primer trozo y UTF-8 válido. */
export function looksLikeText(data: Uint8Array): boolean {
  const sample = data.subarray(0, 8192)
  if (sample.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data)
    return true
  } catch {
    return false
  }
}

/** Lenguaje de Monaco según el nombre del fichero. */
export function languageForFile(name: string): string {
  const lower = name.toLowerCase()
  const byName: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'plaintext',
    '.bashrc': 'shell',
    '.bash_profile': 'shell',
    '.profile': 'shell',
    '.zshrc': 'shell',
    '.env': 'ini',
    'nginx.conf': 'plaintext'
  }
  if (byName[lower]) return byName[lower]
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  const byExt: Record<string, string> = {
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    // El servicio de JSON de Monaco necesita su propio worker; para colorear basta con JavaScript.
    json: 'javascript',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    md: 'markdown',
    py: 'python',
    php: 'php',
    sql: 'sql',
    ini: 'ini',
    conf: 'ini',
    cnf: 'ini',
    toml: 'ini',
    env: 'ini',
    service: 'ini',
    go: 'go',
    rs: 'rust',
    java: 'java',
    rb: 'ruby',
    ps1: 'powershell',
    dockerfile: 'dockerfile'
  }
  return byExt[ext] ?? 'plaintext'
}
