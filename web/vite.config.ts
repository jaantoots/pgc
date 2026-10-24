/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// In development, run `pgc` (it listens on :8765) and `npm run dev`; open the
// URL pgc prints once so the auth cookie is set for localhost.
const backend = process.env.PGC_BACKEND ?? 'http://localhost:8765';

export default defineConfig({
  plugins: [solid()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  // The tested modules are plain TypeScript; no DOM needed.
  test: { environment: 'node' },
  server: {
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        configure: (p) => p.on('proxyReq', (r) => r.removeHeader('origin')),
      },
      '/ws': {
        target: backend,
        ws: true,
        changeOrigin: true,
        configure: (p) => p.on('proxyReqWs', (r) => r.removeHeader('origin')),
      },
    },
  },
});
