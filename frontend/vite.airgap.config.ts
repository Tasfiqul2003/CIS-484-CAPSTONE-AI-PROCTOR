import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

// Development only; confirm host port allocations before use.
export default mergeConfig(base, defineConfig({ server: {
  host: "0.0.0.0", port: 8100, strictPort: true,
  proxy: { "/api": { target: "http://127.0.0.1:8101", changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, "") } },
} }));
