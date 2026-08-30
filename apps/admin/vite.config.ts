import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The Gateway base URL is read at runtime from window.__CCAT_GATEWAY__ (see index.html) or
// VITE_GATEWAY_URL at build time, defaulting to http://localhost:8080.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  if (mode === 'production') {
    const gateway = env.VITE_GATEWAY_URL;
    if (!gateway) throw new Error('VITE_GATEWAY_URL is required for a production Admin build');
    if (new URL(gateway).protocol !== 'https:') throw new Error('VITE_GATEWAY_URL must use HTTPS in production');
  }
  return {
    plugins: [react()],
    server: { port: 8090, host: true },
    preview: { port: 8090, host: true },
    build: { outDir: 'dist' },
  };
});
