import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = `http://127.0.0.1:${process.env.REMOTE_AI_PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // xterm.js and React make one ~570 kB bundle; fine for a self-hosted tool.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      // Keep the browser's Host header: the server refuses requests whose Origin doesn't match it.
      '/api': { target: backend, changeOrigin: false },
      '/ws': { target: backend, ws: true },
    },
  },
});
