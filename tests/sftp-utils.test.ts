import { describe, expect, it } from 'vitest'
import type { RemoteEntry } from '@shared/types'
import { compareEntries, entryType, ownerFromLongname } from '../src/main/ssh/sftp'
import { safeLocalName } from '../src/main/transfers'

const entry = (name: string, type: RemoteEntry['type'], linkTarget?: RemoteEntry['type']): RemoteEntry => ({
  name,
  path: `/${name}`,
  type,
  linkTarget,
  size: 0,
  mtime: 0,
  mode: 0o644,
  uid: 0,
  gid: 0,
  owner: 'root',
  group: 'root'
})

describe('utilidades de SFTP', () => {
  it('tipo según st_mode', () => {
    expect(entryType(0o040755)).toBe('dir')
    expect(entryType(0o100644)).toBe('file')
    expect(entryType(0o120777)).toBe('link')
    expect(entryType(0o020666)).toBe('other')
  })

  it('propietario desde la línea de ls -l', () => {
    expect(ownerFromLongname('-rw-r--r--    1 www-data www-data     1234 Jan  1 12:00 index.php', 33, 33)).toEqual({ owner: 'www-data', group: 'www-data' })
    expect(ownerFromLongname('drwxr-xr-x+   2 ana staff 64 Jan  1 12:00 x', 501, 20)).toEqual({ owner: 'ana', group: 'staff' })
    expect(ownerFromLongname('index.php', 1000, 1000)).toEqual({ owner: '1000', group: '1000' })
  })

  it('ordena carpetas (y enlaces a carpetas) primero, con orden natural', () => {
    const list = [entry('b10', 'file'), entry('b2', 'file'), entry('zeta', 'dir'), entry('enlace', 'link', 'dir'), entry('Alfa', 'file')]
    expect(list.sort(compareEntries).map((e) => e.name)).toEqual(['enlace', 'zeta', 'Alfa', 'b2', 'b10'])
  })

  it('adapta nombres que no valen en Windows', () => {
    expect(safeLocalName('a:b?.log', 'linux')).toBe('a:b?.log')
    expect(safeLocalName('a:b?.log', 'win32')).toBe('a_b_.log')
    expect(safeLocalName('CON', 'win32')).toBe('_CON')
    expect(safeLocalName('fin. ', 'win32')).toBe('fin_')
  })
})
