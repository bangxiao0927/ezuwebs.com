import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_PROXY ?? "http://127.0.0.1:4175";

export default defineConfig({
  plugins: [vue()],
  server: {
    allowedHosts: ["ezuwebs.com", "www.ezuwebs.com"],
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: ["ezuwebs.com", "www.ezuwebs.com"],
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
