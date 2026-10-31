import { defineConfig } from "vite";

export default defineConfig({
  server: { host: true, port: 5173, fs: { allow: [".."] } }, // ../shared lives outside client/
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
