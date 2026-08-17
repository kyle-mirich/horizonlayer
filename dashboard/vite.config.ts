import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const dashboardOrigin = `http://127.0.0.1:${process.env.DASHBOARD_PORT ?? '4317'}`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: 'public',
  plugins: [react()],
  build: {
    assetsInlineLimit: 0,
    outDir: '../dist/dashboard-ui',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5_173,
    strictPort: true,
    proxy: {
      '/api': {
        target: dashboardOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (request.headers.origin) proxyRequest.setHeader('Origin', dashboardOrigin);
          });
        },
      },
    },
  },
});
