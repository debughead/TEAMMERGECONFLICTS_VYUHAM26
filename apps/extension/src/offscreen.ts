// Offscreen document: hosts the same engine worker as the Web Lab (with the D-024 ready handshake).
// Only chrome.runtime is available here, so settings arrive with each request.
import { auditLog, redactScan, scanFile } from "../../weblab/src/engine/client.ts";
import { fromB64, toB64, ToOffscreen, type RedactReply, type ScanReply } from "./messages.ts";


chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  // Requests come only from our own service worker (no tab).
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  const parsed = ToOffscreen.safeParse(raw);
  if (!parsed.success) return false;
  const msg = parsed.data;

  void (async () => {
    try {
      if (msg.type === "offscreen-scan") {
        const result = await scanFile(fromB64(msg.b64), {
          options: { profile: "extension", context: msg.context, ocrPageCap: 3, trustedSite: msg.trustedSite },
          ...(msg.aiKey ? { aiKey: msg.aiKey } : {}),
        });
        sendResponse({ ok: true, result } satisfies ScanReply);
      } else if (msg.type === "offscreen-redact") {
        const r = await redactScan(msg.scanId, { selectedIds: msg.selectedIds, watermark: null, domain: msg.domain });
        sendResponse({ ok: true, verify: r.verify, b64: r.bytes ? toB64(r.bytes) : null, mime: r.mime, unredacted: r.unredacted } satisfies RedactReply);
      } else {
        // Written by the engine worker, the single audit writer for this origin.
        await auditLog({ origin: "extension", action: msg.action, domain: msg.domain, detail: msg.detail, fileSha256: msg.fileSha256 });
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : "Processing failed" });
    }
  })();
  return true;
});

// createDocument() can resolve before this script has registered its listener; tell the service
// worker we're listening so it never sends into the void (D-025).
void chrome.runtime.sendMessage({ type: "offscreen-ready" });
