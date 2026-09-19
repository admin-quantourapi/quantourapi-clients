import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

const commitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return process.env.VITE_COMMIT_HASH || 'unknown'
  }
})()

export default defineConfig({
  envDir: false,
  define: {
    'import.meta.env.VITE_COMMIT_HASH': JSON.stringify(commitHash),
  },
  plugins: [
    tailwindcss(),
    reactRouter(),
    {
      name: 'silence-env-file-warning',
      enforce: 'pre',
      config() {
        // Patch the console to suppress the specific Vite deprecation warning
        // since react-router currently injects envFile: false.
        const originalWarn = console.warn
        console.warn = (...args) => {
          if (args[0] && typeof args[0] === 'string' && args[0].includes('`envFile` option is deprecated')) {
            return
          }
          originalWarn(...args)
        }
      },
    },
  ],
  resolve: {
    tsconfigPaths: true,
    dedupe: [
      'react',
      'react-dom',
    ],
  },
  server: {
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '^/api/.*': {
        target: process.env.INTERNAL_API_URL || 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: [
      'drizzle-orm',
      'postgres',
    ],
  },
})
