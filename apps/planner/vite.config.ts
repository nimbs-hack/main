import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { mapTileProxy } from '../../scripts/api-server.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// Cesium loads its web workers, shaders and widget assets at runtime from
// CESIUM_BASE_URL, so they are copied next to the app instead of bundled.
// Same setup as the map app in the repo root.
const CESIUM_BUILD = 'node_modules/cesium/Build/Cesium'
const CESIUM_BASE = 'cesium'

export default defineConfig({
  plugins: [
    react(),
    // Starts the Go API and forwards /api to it: map tiles and the planner.
    mapTileProxy(),
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((dir) => ({
        src: `${CESIUM_BUILD}/${dir}`,
        dest: CESIUM_BASE,
        rename: { stripBase: 4 },
      })),
    }),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify(`/${CESIUM_BASE}`),
  },
  resolve: {
    // The globe modules live in the repo root and would otherwise pull in the
    // root's own copies of these, giving two Reacts and two Cesiums.
    dedupe: ['react', 'react-dom', 'cesium'],
  },
  // The low zoom levels of the Mars basemap are in the repo's public/tiles.
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  // The globe modules and the design tokens live outside this folder.
  server: { fs: { allow: [repoRoot] } },
})
