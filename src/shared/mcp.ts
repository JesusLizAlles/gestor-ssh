// Servidor MCP local: deja que Claude (Claude Code, Claude Desktop…) trabaje con los servidores
// a los que el usuario le dé acceso, con el nivel que elija.

import type { Environment } from './types'

export const MCP_DEFAULT_PORT = 47821

/**
 * Nivel de acceso del agente a un servidor:
 * - off: no lo ve.
 * - read: consultas de seguridad y estado (no cambian nada).
 * - confirm: además ejecutar comandos, banear IPs y gestionar servicios, con aprobación en la app.
 * - execute: igual, sin preguntar (en producción se rebaja a confirm).
 */
export type McpAccess = 'off' | 'read' | 'confirm' | 'execute'
export const MCP_ACCESS_LEVELS = ['off', 'read', 'confirm', 'execute'] as const satisfies readonly McpAccess[]

export const MCP_ACCESS_LABEL: Record<McpAccess, string> = {
  off: 'Sin acceso',
  read: 'Solo lectura',
  confirm: 'Ejecución con mi aprobación',
  execute: 'Ejecución sin preguntar'
}

/** En producción nunca se ejecuta nada sin que el usuario lo apruebe. */
export function effectiveAccess(environment: Environment, wanted: McpAccess | undefined): McpAccess {
  const access = wanted ?? 'off'
  return environment === 'prod' && access === 'execute' ? 'confirm' : access
}

export interface McpStatus {
  enabled: boolean
  /** El servidor HTTP está escuchando. */
  running: boolean
  port: number
  url: string
  token: string
  /** Nivel guardado por id de servidor (los que no aparecen: off). */
  access: Record<string, McpAccess>
  /** Por qué no arrancó (puerto ocupado…). */
  error: string | null
}

/** Una llamada de Claude, para el registro que se enseña en la interfaz. */
export interface McpActivity {
  time: number
  tool: string
  server: string | null
  ok: boolean
  error?: string
  /** Lo que se ejecutó (comandos, acciones). */
  detail?: string
}

/** El agente quiere hacer algo que cambia el servidor: la app pregunta al usuario. */
export interface McpApprovalRequest {
  id: string
  serverName: string
  environment: Environment
  /** Qué quiere hacer, en una frase. */
  title: string
  /** El comando o la acción exacta. */
  detail: string
  sudo: boolean
}

/** Nombre del servidor MCP en la configuración de los clientes. */
export const MCP_NAME = 'gestor-ssh'

export function claudeCodeCommand(status: Pick<McpStatus, 'url' | 'token'>): string {
  return `claude mcp add --scope user --transport http ${MCP_NAME} ${status.url} --header "Authorization: Bearer ${status.token}"`
}
