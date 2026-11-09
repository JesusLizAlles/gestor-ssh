// Monaco desde el propio paquete (sin CDN), con el coloreado de todos los lenguajes básicos.
import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/features/register.all.js'
import 'monaco-editor/languages/definitions/register.all.js'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

monaco.editor.defineTheme('gestor-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#1e1f22', 'editor.lineHighlightBackground': '#26282e' }
})

export { monaco }
