import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    // In dev mode, proxy API/WS/SSE calls to the backend so the UI's default
    // "http://localhost:3000" bridge URL works without CORS issues.
    proxy: {
      '/health':       { target: 'http://localhost:3000', changeOrigin: true },
      '/submit':       { target: 'http://localhost:3000', changeOrigin: true },
      '/sse':          { target: 'http://localhost:3000', changeOrigin: true },
      '/ws':           { target: 'ws://localhost:3000',  changeOrigin: true, ws: true },
    },
  },
})
