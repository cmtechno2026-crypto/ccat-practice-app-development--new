import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Stateless, CDN-friendly SPA. Gateway base URL is injected at build/run via VITE_GATEWAY_URL.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  preview: { port: 4173, host: true },
  build: { outDir: 'dist', sourcemap: true },
});
