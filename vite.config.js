import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { mapTileProxy } from './scripts/api-server.js'

// Cesium loads its web workers, shaders and widget assets at runtime from
// CESIUM_BASE_URL, so they are copied next to the app instead of bundled.
const CESIUM_BUILD = 'node_modules/cesium/Build/Cesium'
const CESIUM_BASE = 'cesium'

export default defineConfig({
  plugins: [
    react(),
    mapTileProxy(),
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((dir) => ({
        src: `${CESIUM_BUILD}/${dir}`,
        dest: CESIUM_BASE,
        // Drop node_modules/cesium/Build/Cesium from the copied paths.
        rename: { stripBase: 4 },
      })),
    }),
  ],
  // Three pages: the planner, the read-only EVA HUD, and the HUD seen from
  // inside a helmet. The last two load no map code.
  build: {
    rolldownOptions: { input: { main: 'index.html', hud: 'hud.html', helmet: 'helmet.html' } },
  },
  define: {
    CESIUM_BASE_URL: JSON.stringify(`/${CESIUM_BASE}`),
  },
})
