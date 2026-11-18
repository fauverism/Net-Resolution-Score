import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.NRS_API_PORT ?? 5151);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5150,
    strictPort: true,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
});
