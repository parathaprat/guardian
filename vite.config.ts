import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, 'src/web'),
  publicDir: resolve(here, 'src/web/public'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(here, 'src/shared'),
      '@web': resolve(here, 'src/web/src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(here, 'dist/web'),
    emptyOutDir: true,
  },
});
