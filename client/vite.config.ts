import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev, forward API calls to the ASP.NET Core Kestrel host so the browser sees a
    // single same-origin app (no CORS). The kiosk in prod hits the published SPA served
    // by Kestrel directly, so these routes resolve without a proxy there.
    proxy: {
      '/api': 'http://localhost:5220',
    },
  },
  build: {
    // The API serves the built SPA from wwwroot as one deployable unit.
    outDir: '../src/HomeHub.Api/wwwroot',
    emptyOutDir: true,
  },
})
