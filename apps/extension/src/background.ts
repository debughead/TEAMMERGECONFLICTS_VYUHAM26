// Service worker: validates and routes messages only (rules/extension.md). Heavy work runs in the
// offscreen document's Web Worker, because Chrome stops idle service workers.
import {
  DEFAULT_SETTINGS, destinationOf, Settings, StoredPolicy, ToBackground,
  type RedactReply, type ScanReply, type TabStatus, type ToContent, type ToOffscreen,
} from "./messages.ts";

const OFFSCREEN_URL = "offscreen.html";
/** Masked scan results per tab, for the side panel. Session storage clears when the browser closes. */
const tabKey = (tabId: number) => `tab:${tabId}`;
const PANEL_URL = "sidepanel.html";

async function setStatus(tabId: number, scanId: string, status: TabStatus): Promise<void> {
  const key = tabKey(tabId);
  const cur = (await chrome.storage.session.get(key))[key] as { result?: { scanId?: string } } | undefined;
  if (cur?.result?.scanId === scanId) await chrome.storage.session.set({ [key]: { ...cur, status } });
}

async function settings(): Promise<Settings> {
  const raw = await chrome.storage.local.get("settings");
  const parsed = Settings.safeParse(raw["settings"]);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

/** The company policy the user (or IT) put in place, if any (D-039). */
async function storedPolicy(): Promise<StoredPolicy | null> {
  const parsed = StoredPolicy.safeParse((await chrome.storage.local.get("policy"))["policy"]);
  return parsed.success ? parsed.data : null;
}

let creating: Promise<void> | null = null;
let markReady: (() => void) | null = null;
const OFFSCREEN_READY_TIMEOUT_MS = 10_000;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (existing.length && !creating) return;
  // Only one offscreen document may exist; concurrent callers share one creation, which completes
  // only when the document reports that its listener is registered (D-025).
  creating ??= (async () => {
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      setTimeout(() => reject(new Error("The scanner didn't start")), OFFSCREEN_READY_TIMEOUT_MS);
    });
    await chrome.offscreen.createDocument({ url: OFFSCREEN_URL, reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS], justification: "Runs the on-device document scanner (WebAssembly) in a worker" });
    await ready;
  })().finally(() => { creating = null; markReady = null; });
  await creating;
}

async function toOffscreen<T>(msg: ToOffscreen): Promise<T> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  // Only our own content scripts and pages may talk to us.
  if (sender.id !== chrome.runtime.id) return false;
  const parsed = ToBackground.safeParse(raw);
  if (!parsed.success) return false;
  const msg = parsed.data;
  const tabId = sender.tab?.id;

  if (msg.type === "offscreen-ready") {
    if (!sender.tab && sender.url === chrome.runtime.getURL(OFFSCREEN_URL)) markReady?.();
    return false;
  }

  if (msg.type === "open-panel") {
    // Must run synchronously inside the click's gesture window (spike S1).
    if (tabId !== undefined) chrome.sidePanel.open({ tabId }).catch(() => undefined);
    return false;
  }
  if (msg.type === "tab-state") {
    void chrome.storage.session.get(tabKey(msg.tabId)).then((v) => sendResponse(v[tabKey(msg.tabId)] ?? null));
    return true;
  }
  if (msg.type === "panel-redact") {
    // Only our side panel page may ask for this (it has no tab of its own). E2E builds also accept the
    // panel page opened as a tab, so tests can drive it; production builds keep the strict check.
    const panelAsTab = import.meta.env.MODE === "e2e" && Boolean(sender.tab);
    const senderPage = panelAsTab ? sender.url?.split("?")[0] : sender.url;
    if ((sender.tab && !panelAsTab) || senderPage !== chrome.runtime.getURL(PANEL_URL)) return false;
    void (async () => {
      // No "tabs" permission, so the domain comes from the scan we stored for this tab.
      const stored = (await chrome.storage.session.get(tabKey(msg.tabId)))[tabKey(msg.tabId)] as { context?: { domain?: string } } | undefined;
      const reply = await toOffscreen<RedactReply>({ type: "offscreen-redact", scanId: msg.scanId, selectedIds: msg.selectedIds, domain: stored?.context?.domain ?? "" });
      if (!reply.ok || !reply.verify.passed || !reply.b64) return sendResponse(reply);
      const attach: ToContent = { type: "attach-safe", scanId: msg.scanId, b64: reply.b64, mime: reply.mime, removed: msg.selectedIds.length };
      const attached = (await chrome.tabs.sendMessage(msg.tabId, attach)) as { ok: boolean } | undefined;
      if (attached?.ok) await setStatus(msg.tabId, msg.scanId, "safe-uploaded");
      sendResponse({ ...reply, b64: null, attached: Boolean(attached?.ok) });
    })().catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : "Extension error" }));
    return true;
  }
  // Everything else must come from a content script in a tab.
  if (tabId === undefined) return false;
  if (msg.type === "status") {
    void setStatus(tabId, msg.scanId, msg.status);
    return false;
  }

  if (msg.type === "policy-change") {
    // Only our side panel changes the policy (e2e builds also accept the panel opened as a tab).
    const fromPanel = (sender.tab ? import.meta.env.MODE === "e2e" : true) && sender.url?.split("?")[0] === chrome.runtime.getURL(PANEL_URL);
    if (!fromPanel) return false;
    void toOffscreen({ type: "offscreen-audit", action: "policy_change", domain: "", detail: msg.detail, fileSha256: null })
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }

  void (async () => {
    const s = await settings();
    switch (msg.type) {
      case "scan": {
        const policy = await storedPolicy();
        const reply = await toOffscreen<ScanReply>({
          type: "offscreen-scan", b64: msg.b64, context: msg.context,
          trustedSite: s.trusted.includes(msg.context.domain),
          ...(s.aiOn && s.aiKey ? { aiKey: s.aiKey } : {}),
          // The site's domain decides which side of the policy applies: no one has to choose.
          ...(policy ? { policyText: policy.text, destination: destinationOf(policy, msg.context.domain) } : {}),
        });
        if (reply.ok) {
          await chrome.storage.session.set({ [tabKey(tabId)]: { fileName: msg.fileName, context: msg.context, result: reply.result, compliance: reply.compliance, status: "pending" } });
        }
        sendResponse(reply);
        break;
      }
      case "redact":
        sendResponse(await toOffscreen<RedactReply>({ type: "offscreen-redact", scanId: msg.scanId, selectedIds: msg.selectedIds, domain: msg.domain }));
        break;
      case "override":
        await toOffscreen({ type: "offscreen-audit", action: "override", domain: msg.domain, detail: `Uploaded original anyway. Reason: ${msg.reason}`, fileSha256: msg.fileSha256 });
        sendResponse({ ok: true });
        break;
      case "trust":
        if (!s.trusted.includes(msg.domain)) await chrome.storage.local.set({ settings: { ...s, trusted: [...s.trusted, msg.domain] } });
        await toOffscreen({ type: "offscreen-audit", action: "trust_site", domain: msg.domain, detail: "Marked as trusted", fileSha256: null });
        sendResponse({ ok: true });
        break;
    }
  })().catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : "Extension error" }));
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => { void chrome.storage.session.remove(tabKey(tabId)); });
// Guaranteed way to open the panel even if a relayed gesture isn't honoured (spike S1 fallback).
chrome.runtime.onInstalled.addListener(() => { void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); });
