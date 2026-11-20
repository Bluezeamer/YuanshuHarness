/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { xyflowPalette } from "./vite-plugin-xyflow-palette";

export default defineConfig({
  plugins: [xyflowPalette(), react(), tailwindcss()],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:7420", ws: true } },
  },
  // 两个入口：桌面（/）与手机（/m/）
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        m: fileURLToPath(new URL("./m/index.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    // 暖机时每条只要几毫秒；这里兜的是整套并发跑时首条用例的冷启动（动态 import、jsdom 建环境）
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
