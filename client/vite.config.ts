import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// In development the React app runs on :5173 and forwards API + socket traffic
// to the Express server on :3001. In production Express serves the built files itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  // `npm run preview` imitates the Vercel setup: /api forwarded, socket goes direct via VITE_SOCKET_URL
  preview: {
    proxy: { '/api': 'http://localhost:3001' },
  },
})
