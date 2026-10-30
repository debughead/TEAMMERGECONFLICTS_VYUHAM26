import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config.ts";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The content script is one self-contained file: no loader, nothing fetched at runtime.
    crx({ manifest, contentScripts: { standaloneFiles: ["src/content/content.ts"] } }),
  ],
  optimizeDeps: { exclude: ["mupdf", "@redactguard/core"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    // The offscreen document isn't referenced by the manifest, so it's an explicit entry.
    rollupOptions: { input: { offscreen: "offscreen.html", sidepanel: "sidepanel.html" } },
  },
});
