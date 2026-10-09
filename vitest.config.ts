import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  // Permite testar componentes por renderização no servidor (react-dom/server) sem depender do jsx 'preserve' do tsconfig.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
