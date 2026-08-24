import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import path from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**'],
    // Modules like lib/supabase.ts instantiate a client at import time and
    // need these present even for tests that only exercise pure functions.
    env: loadEnv('', process.cwd(), ''),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
