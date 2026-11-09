import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import { App } from './App'
import { GeoProvider } from './lib/geo'
import { SudoProvider } from './lib/sudo'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SudoProvider>
      <GeoProvider>
        <App />
      </GeoProvider>
    </SudoProvider>
  </StrictMode>
)
