import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // '/api/'로 끝을 맞춰 화면 경로 /api-guide 가 백엔드로 넘어가지 않게 한다
      '/api/': { target: process.env.CS_API_URL ?? 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
})
