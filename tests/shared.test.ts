import { describe, expect, it } from 'vitest'
import { formatMode, formatOctal, formatSize, languageForFile, looksLikeText } from '@shared/format'
import { basename, breadcrumbs, isValidName, join, normalize, parent, resolveFromHome } from '@shared/remote-path'
import { cdCommand, shellQuote } from '@shared/shell'

describe('rutas remotas', () => {
  it('normaliza', () => {
    expect(normalize('/')).toBe('/')
    expect(normalize('//etc//nginx/./sites/../conf.d/')).toBe('/etc/nginx/conf.d')
    expect(normalize('/../..')).toBe('/')
  })
  it('une, sube y saca el nombre', () => {
    expect(join('/var/www', 'html')).toBe('/var/www/html')
    expect(join('/var/www', '/etc')).toBe('/etc')
    expect(join('/', 'a b')).toBe('/a b')
    expect(parent('/var/www')).toBe('/var')
    expect(parent('/var')).toBe('/')
    expect(parent('/')).toBe('/')
    expect(basename('/var/www/index.php')).toBe('index.php')
    expect(basename('/')).toBe('/')
  })
  it('migas de pan', () => {
    expect(breadcrumbs('/var/log')).toEqual([
      { name: '/', path: '/' },
      { name: 'var', path: '/var' },
      { name: 'log', path: '/var/log' }
    ])
  })
  it('nombres válidos', () => {
    expect(isValidName('index.php')).toBe(true)
    expect(isValidName('.env')).toBe(true)
    for (const bad of ['', '.', '..', 'a/b', 'a\0b', 'x'.repeat(256)]) expect(isValidName(bad)).toBe(false)
  })
  it('resuelve ~ y rutas relativas', () => {
    expect(resolveFromHome('~', '/home/ana')).toBe('/home/ana')
    expect(resolveFromHome('', '/home/ana')).toBe('/home/ana')
    expect(resolveFromHome('~/web', '/home/ana')).toBe('/home/ana/web')
    expect(resolveFromHome('web/../logs', '/home/ana')).toBe('/home/ana/logs')
    expect(resolveFromHome('/etc', '/home/ana')).toBe('/etc')
  })
})

describe('formato', () => {
  it('tamaños', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1536)).toBe('1,5 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatSize(-1)).toBe('—')
  })
  it('permisos como ls -l', () => {
    expect(formatMode(0o755, 'dir')).toBe('drwxr-xr-x')
    expect(formatMode(0o644, 'file')).toBe('-rw-r--r--')
    expect(formatMode(0o4755, 'file')).toBe('-rwsr-xr-x')
    expect(formatMode(0o1777, 'dir')).toBe('drwxrwxrwt')
    expect(formatMode(0o2640, 'file')).toBe('-rw-r-S---')
    expect(formatMode(0o777, 'link')).toBe('lrwxrwxrwx')
    expect(formatOctal(0o755)).toBe('755')
    expect(formatOctal(0o2775)).toBe('2775')
    expect(formatOctal(0o40755)).toBe('755')
  })
  it('distingue texto de binario', () => {
    expect(looksLikeText(Buffer.from('hola\nqué tal\n'))).toBe(true)
    expect(looksLikeText(Buffer.from([0x68, 0x00, 0x69]))).toBe(false)
    expect(looksLikeText(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false)
  })
  it('lenguaje según el nombre', () => {
    expect(languageForFile('deploy.sh')).toBe('shell')
    expect(languageForFile('docker-compose.yml')).toBe('yaml')
    expect(languageForFile('Dockerfile')).toBe('dockerfile')
    expect(languageForFile('.bashrc')).toBe('shell')
    expect(languageForFile('nginx.conf')).toBe('plaintext')
    expect(languageForFile('README')).toBe('plaintext')
  })
})

describe('shell', () => {
  it('entrecomilla para el shell', () => {
    expect(shellQuote('/var/www')).toBe(`'/var/www'`)
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`)
    expect(cdCommand('/srv/mi web')).toBe(`cd -- '/srv/mi web'`)
  })
})
