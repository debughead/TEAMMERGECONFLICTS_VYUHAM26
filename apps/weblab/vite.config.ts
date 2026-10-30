import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { writeFileSync } from "node:fs";
import type { Plugin } from "vite";

// Self-test only (RG_SELFTEST=1 or the dev server): receives the browser report and writes it to disk.
const SELFTEST = process.env.RG_SELFTEST === "1";
type Middlewares = { use(path: string, fn: (req: NodeJS.ReadableStream, res: { statusCode: number; end(): void }) => void): void };
const sink = (middlewares: Middlewares) =>
    middlewares.use("/__selftest", (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
      req.on("end", () => {
        writeFileSync(new URL("./.selftest-result.json", import.meta.url), body);
        res.statusCode = 204;
        res.end();
      });
    });
const selftestSink = (): Plugin => ({
  name: "rg-selftest-sink",
  configureServer(server) { sink(server.middlewares as unknown as Middlewares); },
  configurePreviewServer(server) { if (SELFTEST) sink(server.middlewares as unknown as Middlewares); },
});

// Same CSP the deployed site sends (docs/HLD.md §3.11). AI is the only allowed outbound origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self' https://api.anthropic.com",
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export default defineConfig({
  plugins: [react(), tailwindcss(), selftestSink()],
  // mupdf finds its .wasm via new URL(..., import.meta.url); pre-bundling would break that path.
  optimizeDeps: { exclude: ["mupdf", "@redactguard/core"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    // Never inline assets as data: URLs; the CSP (connect-src 'self') would block fetching them.
    assetsInlineLimit: 0,
    // The self-test page is only built on request; normal builds ship index.html alone.
    rollupOptions: { input: SELFTEST ? { index: "index.html", selftest: "selftest.html" } : { index: "index.html" } },
  },
  // No CSP on the dev server: Vite's dev client and React refresh inject inline scripts the strict
  // policy (correctly) blocks. The strict CSP is enforced on preview/production builds below.
  server: { headers: { "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } },
  preview: { headers: { "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } },
});
