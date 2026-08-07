import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `npm run dev` serves the SPA; `npm run dev:worker` serves /api on 8787.
    proxy: { '/api': 'http://localhost:8787', '/auth': 'http://localhost:8787' },
  },
})
