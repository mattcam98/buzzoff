import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API server runs separately; proxy to it so the app is same-origin as in production.
const server = process.env.BUZZOFF_SERVER ?? 'http://localhost:3210';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': server,
      '/media': server,
      '/socket.io': { target: server, ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: false },
});
