import type { ServerApi } from '../shared/types'

declare global {
  interface Window {
    api: ServerApi
  }
}

export {}
