import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? 3002}`,
        changeOrigin: true,
      },
    },
  },
});
