import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` proxies the API to a running `bub-walkman <tape> --port 7357 --no-open`.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../src/bub_walkman/static",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:7357" },
  },
});
