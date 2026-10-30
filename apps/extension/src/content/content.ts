// Browser Guard content script (isolated world). Rules: capture-phase listeners on `document`, no
// window.postMessage, read nothing but the upload field's own label/context, UI in a closed shadow
// root, and the original file is never uploaded silently (rules/extension.md).
import type { Finding, ScanContext, ScanResult } from "@redactguard/core/schemas";
import { fromB64, toB64, ToContent, type RedactReply, type ScanReply, type Settings } from "../messages.ts";
import { defaultSelection, GROUPS, groupOf, identityKit, isNeeded, kitSentence, labelOf, listable, receipt, VERDICT_COPY } from "../ui/groups.ts";

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * E2E builds only (`vite build --mode e2e`): reports state transitions (names and counts, never
 * values) to the local demo server. Removed entirely from production builds at compile time.
 */
function trace(event: string, info: Record<string, unknown> = {}): void {
  if (import.meta.env.MODE !== "e2e" || location.origin !== "http://localhost:8080") return;
  void fetch("/__trace", { method: "POST", body: JSON.stringify({ t: Math.round(performance.now()), event, ...info }) });
}
/** Files this script attached itself; their change events pass straight through (spike S4). */
const approved = new WeakSet<File>();
/** Backup for S4: set synchronously around our own dispatch, in case FileList entries aren't the same objects. */
const dispatching = new WeakSet<HTMLInputElement>();
/** Picks waiting for a decision, so the side panel can hand back a verified file (scanId → pick). */
const pending = new Map<string, { input: HTMLInputElement; file: File }>();

// ---------- interception ----------

function onFileEvent(e: Event): void {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
  const file = input.files?.[0];
  if (!file || dispatching.has(input) || approved.has(file)) return;
  // Stop the page from seeing this pick, then take the file out of the input.
  e.stopImmediatePropagation();
  e.preventDefault();
  input.value = "";
  trace("intercepted", { via: e.type });
  void handlePick(input, file).catch((err: unknown) => trace("handlePick-threw", { error: err instanceof Error ? err.message : String(err) }));
}
document.addEventListener("change", onFileEvent, true);
document.addEventListener("input", onFileEvent, true);

// Drops can't be handed back to a site's drop handler reliably (D-004): block and explain.
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  card.show({ kind: "drop" });
}, true);

// The side panel's "Redact selected & upload" arrives here with a verified file.
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  const parsed = ToContent.safeParse(raw);
  if (!parsed.success) return false;
  const msg = parsed.data;
  const pick = pending.get(msg.scanId);
  if (!pick) { sendResponse({ ok: false }); return false; }
  attach(pick.input, cleanFile(pick.file, msg.b64, msg.mime));
  pending.delete(msg.scanId);
  card.toast(`Uploaded a verified safe copy. ${msg.removed} item${msg.removed === 1 ? "" : "s"} removed.`);
  sendResponse({ ok: true });
  return false;
});

// ---------- context (the upload field only) ----------

function labelFor(input: HTMLInputElement): string {
  const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const byFor = input.id ? text(document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) : "";
  const labelledBy = (input.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => text(document.getElementById(id))).join(" ");
  const nearby = text(input.closest("label")) || text(input.previousElementSibling) || text(input.parentElement);
  return (byFor || input.getAttribute("aria-label") || labelledBy || input.title || nearby || input.name || "").slice(0, 120);
}

// ---------- flow ----------

async function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

async function handlePick(input: HTMLInputElement, file: File): Promise<void> {
  const context: ScanContext = { domain: location.hostname.slice(0, 253), fieldLabel: labelFor(input), pageTitle: document.title.slice(0, 300) };
  if (file.size > MAX_BYTES) return card.show({ kind: "error", input, file, context, message: "This file is over 15 MB, which is too large to check here. Open it in the RedactGuard Web Lab instead.", scanId: null });
  card.show({ kind: "scanning", fileName: file.name });
  let reply: ScanReply;
  try {
    const b64 = toB64(new Uint8Array(await file.arrayBuffer()));
    reply = await send<ScanReply>({ type: "scan", b64, fileName: file.name.slice(0, 255), context });
  } catch {
    reply = { ok: false, error: "The checker couldn't be reached. Reload the page and pick the file again." };
  }
  trace("scan-reply", { ok: Boolean(reply?.ok), error: reply && !reply.ok ? reply.error : undefined, verdict: reply?.ok ? reply.result.verdict : undefined, findings: reply?.ok ? reply.result.findings.map((f) => `${f.type}/${f.source}`) : undefined });
  if (!reply?.ok) return card.show({ kind: "error", input, file, context, message: reply?.error ?? "The check didn't finish.", scanId: null });
  const result = reply.result;
  const { mode } = await settings();

  const needed = new Set(result.context?.neededTypes ?? []);
  const onlyCleanable = result.findings.every((f) => f.autoCleanable || needed.has(f.type));
  const office = result.fileType === "docx" || result.fileType === "xlsx";

  // Allowed, or Auto-clean with nothing that needs judgment: clean silently, then tell the user.
  if (!office && (result.verdict === "allow" || (mode === "auto" && onlyCleanable && !result.findings.some((f) => !f.redactable)))) {
    const cleanable = result.findings.filter((f) => f.redactable && f.autoCleanable);
    if (cleanable.length === 0) {
      attach(input, file);
      return card.toast("Checked on your device. Nothing to remove, so the file was attached.");
    }
    if (await safeVersion(input, file, result, cleanable.map((f) => f.id), context)) {
      return card.toast(`Attached a cleaned copy. Removed: ${describe(cleanable)}.`);
    }
    return; // safeVersion showed the failure card; the original was not attached
  }
  pending.set(result.scanId, { input, file });
  card.show({ kind: "verdict", input, file, context, result });
}

async function safeVersion(input: HTMLInputElement, file: File, result: ScanResult, selectedIds: string[], context: ScanContext): Promise<boolean> {
  card.show({ kind: "scanning", fileName: file.name, label: "Removing and verifying" });
  const reply = await send<RedactReply>({ type: "redact", scanId: result.scanId, selectedIds, domain: context.domain });
  trace("redact-reply", { ok: Boolean(reply?.ok), passed: reply?.ok ? reply.verify.passed : undefined, error: reply && !reply.ok ? reply.error : undefined });
  if (!reply?.ok || !reply.b64 || !reply.verify.passed) {
    card.show({ kind: "error", input, file, context, scanId: result.scanId, message: "The cleaned copy didn't pass verification, so nothing was attached. The original wasn't uploaded either." });
    return false;
  }
  attach(input, cleanFile(file, reply.b64, reply.mime));
  pending.delete(result.scanId);
  void send({ type: "status", scanId: result.scanId, status: "safe-uploaded" });
  return true;
}

function cleanFile(original: File, b64: string, mime: string): File {
  // WebP is re-encoded as PNG; keep the name honest about the format.
  const name = mime === "image/png" && !/\.png$/i.test(original.name) ? original.name.replace(/(\.[^.]+)?$/, ".png") : original.name;
  return new File([fromB64(b64)], name, { type: mime, lastModified: Date.now() });
}

/** Puts a file into the input and fires the events sites listen for, without re-intercepting it. */
function attach(input: HTMLInputElement, file: File): void {
  trace("attach", { size: file.size, type: file.type });
  approved.add(file);
  const dt = new DataTransfer();
  dt.items.add(file);
  dispatching.add(input);
  try {
    input.files = dt.files;
    const attached = input.files?.[0];
    if (attached) approved.add(attached);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } finally {
    dispatching.delete(input);
  }
}

const describe = (fs: Finding[]) => [...new Set(fs.map((f) => (f.type === "gps" ? "location" : f.type === "metadata" ? "file details" : "hidden text")))].join(", ");

async function settings(): Promise<Settings> {
  const raw = await chrome.storage.local.get("settings");
  const s = raw["settings"] as Partial<Settings> | undefined;
  return { mode: s?.mode === "auto" ? "auto" : "ask", aiOn: Boolean(s?.aiOn), aiKey: "", trusted: [] };
}

// ---------- verdict card (closed shadow root) ----------

type CardState =
  | { kind: "scanning"; fileName: string; label?: string }
  | { kind: "drop" }
  | { kind: "error"; input: HTMLInputElement; file: File; context: ScanContext; message: string; scanId: string | null }
  | { kind: "verdict"; input: HTMLInputElement; file: File; context: ScanContext; result: ScanResult };

// Palette: white paper, navy ink, quiet rules; verdict colours carry meaning only.
const C = {
  paper: "#FFFFFF", ink: "#1B2A3A", muted: "#5A6676", rule: "#E2E7EE", wash: "#F6F8FA", navy: "#163A5F",
  stop: "#B42318", stopWash: "#FEF3F2", caution: "#B54708", cautionWash: "#FFFAEB", clear: "#1A7F4E", clearWash: "#ECFDF3",
} as const;
const TONE = {
  stop: { fg: C.stop, bg: C.stopWash },
  caution: { fg: C.caution, bg: C.cautionWash },
  clear: { fg: C.clear, bg: C.clearWash },
} as const;

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; }
.card { width: 372px; max-height: min(78vh, 640px); display: flex; flex-direction: column; background: ${C.paper}; color: ${C.ink};
  border: 1px solid ${C.rule}; border-radius: 14px; box-shadow: 0 18px 48px rgba(16, 38, 64, .22), 0 2px 6px rgba(16, 38, 64, .08);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
.card:focus-within { outline: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid ${C.rule}; color: ${C.muted}; font-size: 12.5px; }
.head b { color: ${C.ink}; font-weight: 600; }
.head .x { margin-left: auto; border: 0; background: none; color: ${C.muted}; font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
.band { padding: 14px 16px 12px; border-left: 4px solid var(--fg); background: var(--bg); }
.band h2 { margin: 0; font-size: 16.5px; line-height: 1.3; font-weight: 650; color: var(--fg); }
.file { margin-top: 2px; color: ${C.muted}; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meter { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.cells { display: grid; grid-template-columns: repeat(10, 1fr); gap: 3px; flex: 1; }
.cells i { height: 7px; border-radius: 2px; background: ${C.rule}; }
.cells i.on { background: var(--fg); }
.score { font-variant-numeric: tabular-nums; font-size: 12.5px; color: ${C.muted}; white-space: nowrap; }
.score b { color: ${C.ink}; font-size: 15px; }
.kit { margin-top: 10px; font-size: 12.5px; color: ${C.ink}; }
.body { overflow: auto; padding: 4px 0 6px; }
.group { padding: 10px 16px 4px; }
.gh { display: flex; align-items: center; gap: 8px; }
.gh svg { flex: none; color: ${C.navy}; }
.gh strong { font-size: 13.5px; font-weight: 650; }
.gh span { color: ${C.muted}; font-size: 12px; }
.why { margin: 1px 0 6px 26px; color: ${C.muted}; font-size: 12px; }
label.row { display: grid; grid-template-columns: 18px 1fr; gap: 8px; align-items: start; margin: 0 0 6px 18px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
label.row:hover { background: ${C.wash}; }
label.row.off { cursor: default; opacity: .65; }
label.row input { width: 16px; height: 16px; margin: 2px 0 0; accent-color: ${C.navy}; cursor: inherit; }
.rt { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.rt b { font-weight: 600; font-size: 13.5px; }
.rt code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: ${C.ink}; background: ${C.wash}; border: 1px solid ${C.rule}; padding: 0 5px; border-radius: 5px; }
.rr { color: ${C.muted}; font-size: 12px; margin-top: 1px; }
.tag { font-size: 11.5px; color: ${C.clear}; }
.foot { border-top: 1px solid ${C.rule}; padding: 12px 16px 14px; background: ${C.paper}; }
.receipt { font-size: 12.5px; color: ${C.muted}; margin-bottom: 10px; }
.receipt b { color: ${C.ink}; font-weight: 600; }
button { font: inherit; }
.primary { width: 100%; border: 0; border-radius: 10px; padding: 11px 14px; background: ${C.navy}; color: white; font-weight: 600; font-size: 14px; cursor: pointer; }
.primary:disabled { background: #9AA7B6; cursor: not-allowed; }
.links { display: flex; gap: 14px; margin-top: 10px; flex-wrap: wrap; }
.link { border: 0; background: none; padding: 2px 0; color: ${C.navy}; font-weight: 600; font-size: 13px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: ${C.rule}; }
.link:hover { text-decoration-color: currentColor; }
details { margin-top: 10px; border-top: 1px dashed ${C.rule}; padding-top: 8px; }
summary { cursor: pointer; color: ${C.muted}; font-size: 12.5px; }
.why-box { display: flex; gap: 6px; margin-top: 8px; }
.why-box input { flex: 1; border: 1px solid ${C.rule}; border-radius: 8px; padding: 7px 9px; font: inherit; font-size: 13px; color: ${C.ink}; }
.why-box input.bad { border-color: ${C.stop}; }
.ghost { border: 1px solid ${C.rule}; border-radius: 8px; background: white; padding: 7px 10px; font-weight: 600; font-size: 13px; color: ${C.ink}; cursor: pointer; }
.msg { padding: 14px 16px; }
.msg p { margin: 6px 0 0; color: ${C.ink}; }
.spin { width: 14px; height: 14px; border: 2px solid ${C.rule}; border-top-color: ${C.navy}; border-radius: 50%; animation: s 0.9s linear infinite; flex: none; }
@keyframes s { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
:focus-visible { outline: 2px solid ${C.navy}; outline-offset: 2px; }
`;

// Simple 16px line icons (no remote assets allowed in the page).
const ICON: Record<string, string> = {
  shield: "M8 1.5 2.5 3.5v4c0 3.4 2.3 5.9 5.5 7 3.2-1.1 5.5-3.6 5.5-7v-4L8 1.5Z",
  hidden: "M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Zm6 1.8A1.8 1.8 0 1 0 8 6.2a1.8 1.8 0 0 0 0 3.6ZM2.5 2.5l11 11",
  ids: "M2 3.5h12v9H2zM4.5 6.5h3M4.5 9.5h5M11 6.5h1",
  personal: "M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-5 6c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8",
  file: "M8 14.5s4.5-4 4.5-7.5a4.5 4.5 0 0 0-9 0c0 3.5 4.5 7.5 4.5 7.5Zm0-6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
};
function icon(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICON[name] ?? "");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.4");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.append(p);
  return svg;
}

/** The RedactGuard mark (shield, page, redaction bar), same geometry as the extension icon. */
function logo(size = 18): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 128 128");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };
  shape("path", { d: "M64 8 L112 24 L112 60 C112 92 92 112 64 122 C36 112 16 92 16 60 L16 24 Z", fill: "#163A5F" });
  shape("rect", { x: "38", y: "32", width: "52", height: "64", rx: "7", fill: "#FFFFFF" });
  shape("rect", { x: "46", y: "44", width: "36", height: "6", rx: "3", fill: "#9AA7B6" });
  shape("rect", { x: "46", y: "57", width: "36", height: "12", rx: "2", fill: "#1B2A3A" });
  shape("rect", { x: "46", y: "78", width: "28", height: "6", rx: "3", fill: "#9AA7B6" });
  return svg;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) if (k !== null) n.append(k);
  return n;
}

const card = (() => {
  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;

  const mount = (): ShadowRoot => {
    if (host?.isConnected && root) return root;
    host = document.createElement("redactguard-card");
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;";
    root = host.attachShadow({ mode: "closed" });
    (document.body ?? document.documentElement).appendChild(host);
    return root;
  };
  const close = () => { host?.remove(); host = null; root = null; };

  const render = (...kids: Node[]) => {
    const r = mount();
    r.replaceChildren(h("style", {}, CSS_TEXT), ...kids);
  };

  const header = () => {
    const x = h("button", { class: "x", "aria-label": "Close" }, "×");
    x.addEventListener("click", close);
    const brand = h("span", {}, h("b", {}, "RedactGuard"), " checked this file on your device");
    return h("div", { class: "head" }, logo(18), brand, x);
  };

  function show(state: CardState): void {
    if (state.kind === "scanning") {
      render(h("div", { class: "card", role: "status" }, header(),
        h("div", { class: "msg" }, h("div", { class: "gh" }, h("div", { class: "spin" }), h("strong", {}, `${state.label ?? "Checking"} ${state.fileName}`)),
          h("p", {}, "The page won't receive anything until this finishes."))));
      return;
    }
    if (state.kind === "drop") {
      const ok = h("button", { class: "primary" }, "Got it");
      ok.addEventListener("click", close);
      render(h("div", { class: "card", role: "alertdialog" }, header(), h("div", { class: "msg" },
        h("strong", {}, "Dropped files can't be checked on this page"),
        h("p", {}, "Use the page's upload button instead. RedactGuard checks the file before the site gets it."),
        h("div", { style: "margin-top:12px" }, ok))));
      return;
    }
    if (state.kind === "error") {
      render(h("div", { class: "card", role: "alertdialog" }, header(), h("div", { class: "msg" },
        h("strong", {}, "Upload paused"), h("p", {}, state.message),
        override(state.input, state.file, state.context, null, state.scanId))));
      return;
    }
    renderVerdict(state);
  }

  function renderVerdict(state: Extract<CardState, { kind: "verdict" }>): void {
    const { result, input, file, context } = state;
    const selected = defaultSelection(result);
    const copy = VERDICT_COPY[result.verdict];
    const tone = TONE[copy.tone];
    const office = result.fileType === "docx" || result.fileType === "xlsx";

    const band = h("div", { class: "band" });
    band.style.setProperty("--fg", tone.fg);
    band.style.setProperty("--bg", tone.bg);
    const cells = h("div", { class: "cells", "aria-hidden": "true" });
    const lit = Math.max(1, Math.round(result.exposureScore / 10));
    for (let i = 0; i < 10; i++) cells.append(h("i", i < lit ? { class: "on" } : {}));
    const kit = identityKit(result);
    band.append(
      h("h2", {}, copy.title),
      h("div", { class: "file", title: file.name }, `${file.name}${result.context && !result.context.expected ? `. ${context.domain} doesn't usually ask for this kind of document.` : ""}`),
      h("div", { class: "meter" }, cells, h("span", { class: "score" }, h("b", {}, String(result.exposureScore)), " / 100 exposure")),
    );
    if (kit) band.append(h("div", { class: "kit" }, kitSentence(kit.masked)));

    const receiptEl = h("div", { class: "receipt", "aria-live": "polite" });
    const primary = h("button", { class: "primary" });
    const refresh = () => {
      const { keeps, removed } = receipt(result, selected);
      receiptEl.replaceChildren(
        "The site will get ", h("b", {}, keeps.length ? keeps.join(", ") : "the document with nothing personal left"),
        removed ? `. Removed: ${removed} item${removed === 1 ? "" : "s"}.` : ".",
      );
      primary.textContent = office ? "Word and Excel files can't be cleaned here" : removed ? `Upload safe version (removes ${removed})` : "Select something to remove";
      primary.toggleAttribute("disabled", office || removed === 0);
    };

    const body = h("div", { class: "body" });
    for (const g of GROUPS) {
      const items = listable(result).filter((f) => groupOf(f) === g.id);
      if (!items.length) continue;
      const group = h("section", { class: "group", "aria-label": g.title },
        h("div", { class: "gh" }, icon(g.id), h("strong", {}, g.title), h("span", {}, String(items.length))),
        h("div", { class: "why" }, g.why));
      for (const f of items) group.append(row(f));
      body.append(group);
    }

    function row(f: Finding): HTMLLabelElement {
      const box = h("input", { type: "checkbox" });
      box.checked = selected.has(f.id);
      box.disabled = !f.redactable || office;
      box.addEventListener("change", () => { box.checked ? selected.add(f.id) : selected.delete(f.id); refresh(); });
      const needed = isNeeded(result, f);
      return h("label", { class: `row${box.disabled ? " off" : ""}` }, box, h("div", {},
        h("div", { class: "rt" }, h("b", {}, labelOf(f)), h("code", {}, f.masked), needed ? h("span", { class: "tag" }, "this page asks for it") : null),
        h("div", { class: "rr" }, f.redactable ? f.reason : `${f.reason}. Can't be removed from this file type here.`)));
    }

    primary.addEventListener("click", () => {
      void safeVersion(input, file, result, [...selected], context).then((ok) => { if (ok) toast(`Uploaded a verified safe copy. ${selected.size} item${selected.size === 1 ? "" : "s"} removed.`); });
    });
    const details = h("button", { class: "link" }, "Review in side panel");
    details.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "open-panel" }));
    const trust = h("button", { class: "link" }, `Trust ${context.domain}`);
    trust.addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "trust", domain: context.domain }).then(() => {
        trust.textContent = "Trusted. Future warnings here will be relaxed; blocks still apply.";
        trust.setAttribute("disabled", "");
      });
    });

    refresh();
    render(h("div", { class: "card", role: "alertdialog", "aria-label": copy.title }, header(), band, body,
      h("div", { class: "foot" }, receiptEl, primary, h("div", { class: "links" }, details, trust),
        office ? h("div", { class: "rr", style: "margin-top:8px" }, "To remove text from Word or Excel files, export to PDF and upload that.") : null,
        override(input, file, context, result.fileSha256, result.scanId))));
  }

  /** "Upload the original anyway" always asks for a reason and writes an audit row first. */
  function override(input: HTMLInputElement, file: File, context: ScanContext, fileSha256: string | null, scanId: string | null): Node {
    const reason = h("input", { placeholder: "Why? (required, saved to your audit log)", "aria-label": "Reason for uploading the original" });
    const go = h("button", { class: "ghost" }, "Upload original");
    go.addEventListener("click", () => {
      const why = reason.value.trim();
      if (why.length < 3) { reason.classList.add("bad"); reason.focus(); return; }
      void chrome.runtime.sendMessage({ type: "override", reason: why.slice(0, 200), domain: context.domain, fileSha256: fileSha256 ?? "unknown" }).then(() => {
        attach(input, file);
        if (scanId) { pending.delete(scanId); void send({ type: "status", scanId, status: "original-uploaded" }); }
        toast("Original attached. Your reason was saved to the audit log.");
      });
    });
    return h("details", {}, h("summary", {}, "Upload the original anyway"), h("div", { class: "why-box" }, reason, go));
  }

  function toast(message: string): void {
    render(h("div", { class: "card", role: "status" }, header(), h("div", { class: "msg" }, h("div", { class: "gh" }, icon("shield"), h("strong", {}, message)))));
    setTimeout(close, 6000);
  }

  return { show, toast, close };
})();
