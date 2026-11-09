/** Comillas simples para el shell POSIX: a'b → 'a'\''b'. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** Comando para que un terminal recién abierto empiece en `cwd`. */
export const cdCommand = (cwd: string): string => `cd -- ${shellQuote(cwd)}`
