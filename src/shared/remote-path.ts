// Rutas del servidor: siempre POSIX, con independencia del sistema en el que corre la app.

/** Normaliza una ruta absoluta: quita `.`, resuelve `..` y barras repetidas. */
export function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Une una carpeta con un nombre o con una ruta relativa; si `child` es absoluta, gana ella. */
export function join(dir: string, child: string): string {
  return normalize(child.startsWith('/') ? child : `${dir}/${child}`)
}

export function parent(path: string): string {
  return normalize(`${normalize(path)}/..`)
}

export function basename(path: string): string {
  const n = normalize(path)
  return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1)
}

/** Segmentos para la ruta de migas: [{name:'/', path:'/'}, {name:'etc', path:'/etc'}, …]. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const crumbs = [{ name: '/', path: '/' }]
  let current = ''
  for (const part of normalize(path).split('/').filter(Boolean)) {
    current += `/${part}`
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

/** ¿Es un nombre válido para un único fichero o carpeta (sin barras ni nombres especiales)? */
export function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !name.includes('/') && !name.includes('\0') && name !== '.' && name !== '..'
}

/** Expande `~` y rutas relativas respecto a la carpeta personal. */
export function resolveFromHome(input: string, home: string): string {
  const trimmed = input.trim()
  if (!trimmed || trimmed === '~') return normalize(home)
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return join(home, trimmed)
}
