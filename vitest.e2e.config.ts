import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) }
  },
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    // Un solo proceso: los pasos comparten la misma ventana de Electron.
    fileParallelism: false
  }
})
