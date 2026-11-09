// Servidor MCP local: deja que Claude (Claude Code, Claude Desktop…) consulte los servidores conectados.

export const MCP_DEFAULT_PORT = 47821

export interface McpStatus {
  enabled: boolean
  /** El servidor HTTP está escuchando. */
  running: boolean
  port: number
  url: string
  token: string
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
}

/** Nombre del servidor MCP en la configuración de los clientes. */
export const MCP_NAME = 'gestor-ssh'

export function claudeCodeCommand(status: Pick<McpStatus, 'url' | 'token'>): string {
  return `claude mcp add --transport http ${MCP_NAME} ${status.url} --header "Authorization: Bearer ${status.token}"`
}

export function claudeDesktopConfig(status: Pick<McpStatus, 'url' | 'token'>): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_NAME]: {
          command: 'npx',
          args: ['-y', 'mcp-remote', status.url, '--header', `Authorization: Bearer ${status.token}`]
        }
      }
    },
    null,
    2
  )
}
