import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  optimizeDeps: { exclude: ["@mediapipe/tasks-vision"] },
  build: { target: "esnext", chunkSizeWarningLimit: 2000 },
  test: { environment: "jsdom", globals: true },
});
