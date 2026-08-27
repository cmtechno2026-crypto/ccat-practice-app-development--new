import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Gateway base URL is read at runtime from window.__CCAT_GATEWAY__ (see index.html) or
// VITE_GATEWAY_URL at build time, defaulting to http://localhost:8080.
export default defineConfig({
  plugins: [react()],
  server: { port: 8090, host: true },
  preview: { port: 8090, host: true },
  build: { outDir: 'dist' },
});
