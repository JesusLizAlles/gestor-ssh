// Iconos de trazo (16 px, color del texto) para barras de herramientas, pestañas y la lista de ficheros.
const PATHS = {
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  up: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  back: <path d="M13 8H3.5M7.5 4l-4 4 4 4" />,
  home: <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5v6.5h3v-3.5h2v3.5h3V6.5" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.55" />
      <path d="M11.8 2.2v2.6H9.2" />
    </>
  ),
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  folderPlus: (
    <>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      <path d="M8 7v4M6 9h4" />
    </>
  ),
  file: <path d="M4 2h5l3 3v9H4zM9 2v3h3" />,
  filePlus: (
    <>
      <path d="M4 2h5l3 3v9H4zM9 2v3h3" />
      <path d="M8 7.5v4M6 9.5h4" />
    </>
  ),
  link: (
    <>
      <path d="M4 2h5l3 3v9H4zM9 2v3h3" />
      <path d="M6 12l3.5-3.5M7 8.5h2.5V11" />
    </>
  ),
  upload: <path d="M8 10V2.5M5 5.5l3-3 3 3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />,
  download: <path d="M8 2.5V10M5 7l3 3 3-3M3 10.5v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />,
  terminal: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M4.5 6l2 2-2 2M8 10.5h3.5" />
    </>
  ),
  server: (
    <>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <path d="M5 4.75h.01M5 11.25h.01" />
    </>
  ),
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  connect: <path d="M6 3.5v3M10 3.5v3M4.5 6.5h7v2a3.5 3.5 0 0 1-7 0zM8 12v2" />,
  disconnect: <path d="M6 3.5v3M10 3.5v3M4.5 6.5h7v2a3.5 3.5 0 0 1-7 0zM8 12v2M2.5 13.5l11-11" />,
  transfer: <path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5" />,
  save: (
    <>
      <path d="M3 3h8l2 2v8H3z" />
      <path d="M5.5 3v3h4.5V3M5.5 13V9.5h5V13" />
    </>
  )
}

export type IconName = keyof typeof PATHS

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`svg-icon ${className ?? ''}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
