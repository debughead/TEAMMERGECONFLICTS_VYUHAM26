import { defineManifest } from "@crxjs/vite-plugin";

// Permission changes need approval (CLAUDE.md "Stop and ask" #3).
export default defineManifest({
  manifest_version: 3,
  name: "RedactGuard Browser Guard",
  version: "0.1.0",
  description: "Checks files before you upload them, removes what a site doesn't need, and proves it's gone. Runs on your device.",
  minimum_chrome_version: "116",
  permissions: ["storage", "sidePanel", "offscreen"],
  optional_host_permissions: ["https://api.anthropic.com/*"],
  background: { service_worker: "src/background.ts", type: "module" },
  content_scripts: [
    { matches: ["<all_urls>"], js: ["src/content/content.ts"], run_at: "document_start", all_frames: true },
  ],
  side_panel: { default_path: "sidepanel.html" },
  icons: { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
  action: { default_title: "RedactGuard", default_icon: { 16: "icons/icon16.png", 32: "icons/icon32.png" } },
  // MV3 minimum policy plus a network allow-list (D-027): 'wasm-unsafe-eval' lets MuPDF and Tesseract
  // compile WebAssembly, and connect-src means nothing in the extension can reach any server except
  // the Anthropic API (used only when the user turns AI on).
  // img-src: extension images, plus OpenStreetMap tiles for the GPS map, which loads only when the user
  // clicks "Show approximate area" (D-036). Nothing else can load images.
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://api.anthropic.com; img-src 'self' data: https://tile.openstreetmap.org;" },
});
