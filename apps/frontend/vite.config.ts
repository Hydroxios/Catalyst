import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En dev : le backend Catalyst tourne sur :3000 (CATALYST_API pour changer).
const api = process.env.CATALYST_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/health': { target: api, changeOrigin: true },
      '/auth': { target: api, changeOrigin: true },
      '/webhooks': { target: api, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
