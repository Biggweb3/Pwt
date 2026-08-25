import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// All API calls use relative URLs; in dev Vite proxies /api to the server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
