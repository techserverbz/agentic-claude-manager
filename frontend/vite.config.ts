import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    /* Pin the bind address. Left to itself Vite listens on ::1 ONLY, so
       http://127.0.0.1:5840 is refused while http://localhost:5840 works. That
       asymmetry is a genuine trap — anything probing the dev server on IPv4
       (a health check, a proxy, a script) sees it as down while the browser,
       resolving localhost to ::1, sees it as up. Pinning makes both agree. */
    host: '127.0.0.1',
    port: 5840,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:4840', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4840', ws: true },
    },
  },
})
