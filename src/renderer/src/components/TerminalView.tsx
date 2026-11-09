import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { TerminalToMain, TerminalToRenderer } from '@shared/types'
import { takeTerminalPort } from '../lib/terminal-ports'
import { ContextMenu } from './ContextMenu'

interface Props {
  serverId: string
  connected: boolean
  active: boolean
  /** Comando que se escribe nada más abrir (p. ej. `cd` a la carpeta del explorador). */
  initialCommand?: string
  onTitle: (title: string) => void
}

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, 'DejaVu Sans Mono', monospace"
const isMac = navigator.platform.toLowerCase().includes('mac')

/** Un shell interactivo en el servidor, pintado con xterm.js. */
export function TerminalView({ serverId, connected, active, initialCommand, onTitle }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const portRef = useRef<MessagePort | null>(null)
  const exitedRef = useRef(false)
  const connectedRef = useRef(connected)
  const openRef = useRef<() => void>(() => {})
  const onTitleRef = useRef(onTitle)
  const [status, setStatus] = useState<'opening' | 'open' | 'exited'>('opening')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  connectedRef.current = connected
  onTitleRef.current = onTitle

  const send = (message: TerminalToMain) => portRef.current?.postMessage(message)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      theme: {
        background: '#1e1f22',
        foreground: '#dfe1e5',
        cursor: '#dfe1e5',
        selectionBackground: '#2e436e'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // window.open lo intercepta el proceso principal y abre el enlace en el navegador.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
    term.open(hostRef.current!)
    termRef.current = term
    fitRef.current = fit
    let disposed = false
    let firstOpen = true

    const copySelection = () => {
      const text = term.getSelection()
      if (text) void navigator.clipboard.writeText(text)
    }
    const paste = async () => {
      const text = await navigator.clipboard.readText().catch(() => '')
      if (text) term.paste(text)
    }
    // Ctrl+Shift+C / Ctrl+Shift+V (y Ctrl/Shift+Insert) como en los terminales de Linux; en macOS van por el menú.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || isMac) return true
      const key = e.key.toLowerCase()
      if ((e.ctrlKey && e.shiftKey && key === 'c') || (e.ctrlKey && key === 'insert')) {
        copySelection()
        return false
      }
      if ((e.ctrlKey && e.shiftKey && key === 'v') || (e.shiftKey && key === 'insert')) {
        e.preventDefault()
        void paste()
        return false
      }
      return true
    })

    const open = async () => {
      exitedRef.current = false
      setStatus('opening')
      try {
        fit.fit()
      } catch {
        // Sin tamaño todavía (pestaña oculta): se usan las medidas por defecto.
      }
      const terminalId = crypto.randomUUID()
      const portPromise = takeTerminalPort(terminalId)
      try {
        await window.api.openTerminal(serverId, terminalId, term.cols, term.rows)
        const port = await portPromise
        if (disposed) {
          port.postMessage({ type: 'close' } satisfies TerminalToMain)
          port.close()
          return
        }
        portRef.current = port
        port.onmessage = (event: MessageEvent<TerminalToRenderer>) => {
          const message = event.data
          if (message.type === 'data') {
            const bytes = message.data.length
            term.write(message.data, () => port.postMessage({ type: 'ack', bytes } satisfies TerminalToMain))
          } else {
            exitedRef.current = true
            portRef.current = null
            setStatus('exited')
            term.write(`\r\n\x1b[2m[${message.reason}. Pulsa Intro para abrir otra sesión]\x1b[0m\r\n`)
          }
        }
        port.start()
        setStatus('open')
        if (firstOpen && initialCommand) send({ type: 'input', data: `${initialCommand}\r` })
        firstOpen = false
      } catch (err) {
        portPromise.catch(() => {})
        if (disposed) return
        exitedRef.current = true
        setStatus('exited')
        term.write(`\r\n\x1b[31m${(err as Error).message}\x1b[0m\r\n\x1b[2m[Pulsa Intro para reintentar]\x1b[0m\r\n`)
      }
    }
    openRef.current = () => void open()

    term.onData((data) => {
      if (exitedRef.current) {
        if (data === '\r' && connectedRef.current) void open()
        return
      }
      send({ type: 'input', data })
    })
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
    term.onTitleChange((title) => onTitleRef.current(title))

    const observer = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent === null) return
      try {
        fit.fit()
      } catch {
        // El contenedor puede estar a 0 px durante un instante.
      }
    })
    observer.observe(hostRef.current!)

    void open()
    return () => {
      disposed = true
      observer.disconnect()
      const port = portRef.current
      portRef.current = null
      if (port) {
        port.postMessage({ type: 'close' } satisfies TerminalToMain)
        port.close()
      }
      term.dispose()
    }
    // El terminal se crea una vez por pestaña; serverId e initialCommand no cambian.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Al volver a la pestaña: reajustar el tamaño (oculta no se puede medir) y dar el foco.
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // Sin tamaño todavía.
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  return (
    <div
      className="terminal-host"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div ref={hostRef} style={{ height: '100%' }} />
      {status === 'exited' && connected && (
        <button className="terminal-overlay primary" onClick={() => openRef.current()}>
          Abrir otra sesión
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            setMenu(null)
            termRef.current?.focus()
          }}
          items={[
            {
              label: 'Copiar',
              onSelect: () => {
                const text = termRef.current?.getSelection()
                if (text) void navigator.clipboard.writeText(text)
              }
            },
            {
              label: 'Pegar',
              onSelect: async () => {
                const text = await navigator.clipboard.readText()
                if (text) termRef.current?.paste(text)
              }
            },
            { label: 'Seleccionar todo', onSelect: () => termRef.current?.selectAll() },
            { label: 'Limpiar', onSelect: () => termRef.current?.clear() }
          ]}
        />
      )}
    </div>
  )
}
