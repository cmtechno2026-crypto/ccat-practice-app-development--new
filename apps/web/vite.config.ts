import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Stateless, CDN-friendly SPA. Gateway base URL is injected at build/run via VITE_GATEWAY_URL.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  if (mode === 'production') {
    const gateway = env.VITE_GATEWAY_URL;
    if (!gateway) throw new Error('VITE_GATEWAY_URL is required for a production Student Web build');
    if (new URL(gateway).protocol !== 'https:') throw new Error('VITE_GATEWAY_URL must use HTTPS in production');
  }
  return {
    plugins: [react()],
    server: { port: 5173, host: true },
    preview: { port: 4173, host: true },
    build: { outDir: 'dist', sourcemap: mode !== 'production' },
  };
});
