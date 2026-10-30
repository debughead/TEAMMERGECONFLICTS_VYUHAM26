// Side panel: the full review for the file picked in this tab (choose exactly what to remove), plus
// settings. Same design language as the in-page card.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Finding, ScanContext, ScanResult, VerifyReport } from "@redactguard/core/schemas";
import { DEFAULT_SETTINGS, Settings, type TabStatus } from "../messages.ts";
import { defaultSelection, GROUPS, groupOf, identityKit, isNeeded, kitSentence, labelOf, listable, receipt, VERDICT_COPY } from "../ui/groups.ts";

interface TabState { fileName: string; context: ScanContext; result: ScanResult; status: TabStatus }
type PanelReply = { ok: true; verify: VerifyReport; attached: boolean } | { ok: false; error: string };

const TONE = {
  stop: "border-[#B42318] bg-[#FEF3F2] text-[#B42318]",
  caution: "border-[#B54708] bg-[#FFFAEB] text-[#B54708]",
  clear: "border-[#1A7F4E] bg-[#ECFDF3] text-[#1A7F4E]",
} as const;
const CELL = { stop: "bg-[#B42318]", caution: "bg-[#B54708]", clear: "bg-[#1A7F4E]" } as const;
const STATUS_COPY: Record<Exclude<TabStatus, "pending">, string> = {
  "safe-uploaded": "A verified safe copy was attached to the page.",
  "original-uploaded": "The original was attached. Your reason is in the audit log.",
  cancelled: "This upload was cancelled.",
};

export function Panel() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [state, setState] = useState<TabState | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const lastScan = useRef<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) return;
      setTabId(tab.id);
      const s = (await chrome.runtime.sendMessage({ type: "tab-state", tabId: tab.id })) as TabState | null;
      setState(s);
      // A new file in this tab resets the selection to the safe default.
      if (s && s.result.scanId !== lastScan.current) {
        lastScan.current = s.result.scanId;
        setSelected(defaultSelection(s.result));
        setOutcome(null);
      }
    };
    void load();
    const t = setInterval(load, 1200);
    void chrome.storage.local.get("settings").then((v) => { const p = Settings.safeParse(v["settings"]); if (p.success) setSettings(p.data); });
    return () => clearInterval(t);
  }, []);

  const save = (next: Settings) => { setSettings(next); void chrome.storage.local.set({ settings: next }); };
  const toggleAi = async (on: boolean) => {
    // Host access to the API is requested only now, from this click (optional permission).
    if (on && !(await chrome.permissions.request({ origins: ["https://api.anthropic.com/*"] }))) return;
    save({ ...settings, aiOn: on });
  };

  const redactSelected = async () => {
    if (!state || tabId === null) return;
    setBusy(true);
    setOutcome(null);
    const reply = (await chrome.runtime.sendMessage({ type: "panel-redact", tabId, scanId: state.result.scanId, selectedIds: [...selected] })) as PanelReply;
    setBusy(false);
    if (!reply.ok) return setOutcome(`Couldn't finish: ${reply.error}. Pick the file again on the page.`);
    if (!reply.verify.passed) return setOutcome("The cleaned copy didn't pass verification, so nothing was attached.");
    setOutcome(reply.attached ? `Verified and attached. ${reply.verify.recoverableItems} recoverable items left in the file.` : "Verified, but the page's upload field was gone. Pick the file again.");
  };

  return (
    <div className="min-h-screen bg-white text-[#1B2A3A] [font-family:system-ui,-apple-system,'Segoe_UI',Roboto,sans-serif]">
      <header className="flex items-center gap-2 border-b border-[#E2E7EE] px-4 py-3">
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden className="text-[#163A5F]"><path d="M8 1.5 2.5 3.5v4c0 3.4 2.3 5.9 5.5 7 3.2-1.1 5.5-3.6 5.5-7v-4L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
        <h1 className="text-[15px] font-semibold">RedactGuard</h1>
        <span className="ml-auto text-xs text-[#5A6676]">Everything runs on this device</span>
      </header>

      {state ? <Review state={state} selected={selected} setSelected={setSelected} busy={busy} outcome={outcome} onRedact={redactSelected} />
        : <p className="px-4 py-6 text-sm text-[#5A6676]">Choose a file in any upload field. RedactGuard checks it here before the site receives it.</p>}

      <section className="border-t border-[#E2E7EE] px-4 py-4 text-sm">
        <h2 className="mb-2 font-semibold">How RedactGuard acts</h2>
        <Choice checked={settings.mode === "ask"} onChange={() => save({ ...settings, mode: "ask" })} title="Ask me" sub="Show what was found and let me choose." />
        <Choice checked={settings.mode === "auto"} onChange={() => save({ ...settings, mode: "auto" })} title="Clean automatically" sub="Remove location, file details and hidden text without asking. Anything else still asks." />
        <label className="mt-3 flex items-start gap-2">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[#163A5F]" checked={settings.aiOn} onChange={(e) => void toggleAi(e.target.checked)} />
          <span><span className="font-medium">AI review</span><span className="block text-xs text-[#5A6676]">Claude Opus 5.5 with your own key. Only short lines are sent, with IDs, names and addresses replaced by placeholders.</span></span>
        </label>
        {settings.aiOn && (
          <input type="password" placeholder="Anthropic API key" value={settings.aiKey} onChange={(e) => save({ ...settings, aiKey: e.target.value.trim() })}
            className="mt-2 w-full rounded-lg border border-[#E2E7EE] px-3 py-2 text-sm" />
        )}
        <h3 className="mt-4 font-medium">Trusted sites</h3>
        {settings.trusted.length === 0 ? <p className="text-xs text-[#5A6676]">None yet. Trusting a site relaxes warnings there; blocks still apply.</p>
          : <ul className="mt-1 space-y-1">{settings.trusted.map((d) => (
            <li key={d} className="flex items-center justify-between rounded-md bg-[#F6F8FA] px-2 py-1 text-xs">
              <span>{d}</span>
              <button className="font-semibold text-[#163A5F] underline underline-offset-2" onClick={() => save({ ...settings, trusted: settings.trusted.filter((x) => x !== d) })}>Remove</button>
            </li>))}</ul>}
      </section>
    </div>
  );
}

function Review({ state, selected, setSelected, busy, outcome, onRedact }: {
  state: TabState; selected: Set<string>; setSelected: (s: Set<string>) => void; busy: boolean; outcome: string | null; onRedact: () => void;
}) {
  const { result, context, fileName, status } = state;
  const copy = VERDICT_COPY[result.verdict];
  const office = result.fileType === "docx" || result.fileType === "xlsx";
  const { keeps, removed } = useMemo(() => receipt(result, selected), [result, selected]);
  const kit = identityKit(result);
  const lit = Math.max(1, Math.round(result.exposureScore / 10));
  const done = status !== "pending";
  const toggle = (f: Finding) => {
    const next = new Set(selected);
    next.has(f.id) ? next.delete(f.id) : next.add(f.id);
    setSelected(next);
  };

  return (
    <div>
      <div className={`border-l-4 px-4 py-3 ${TONE[copy.tone]}`}>
        <h2 className="text-[16px] font-semibold leading-snug">{copy.title}</h2>
        <p className="truncate text-xs text-[#5A6676]" title={fileName}>{fileName} on {context.domain}</p>
        <div className="mt-2 flex items-center gap-3">
          <div className="grid flex-1 grid-cols-10 gap-[3px]" aria-hidden>
            {Array.from({ length: 10 }, (_, i) => <i key={i} className={`h-[7px] rounded-sm ${i < lit ? CELL[copy.tone] : "bg-[#E2E7EE]"}`} />)}
          </div>
          <span className="whitespace-nowrap text-xs text-[#5A6676] [font-variant-numeric:tabular-nums]"><b className="text-[15px] text-[#1B2A3A]">{result.exposureScore}</b> / 100 exposure</span>
        </div>
        {kit && <p className="mt-2 text-xs text-[#1B2A3A]">{kitSentence(kit.masked)}</p>}
        {result.context && (
          <p className="mt-2 text-xs text-[#1B2A3A]">Upload field “{context.fieldLabel || "unlabelled"}”: this page {result.context.expected ? "asks for this kind of document" : "doesn't usually ask for this kind of document"}.</p>
        )}
      </div>

      {GROUPS.map((g) => {
        const items = listable(result).filter((f) => groupOf(f) === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="px-4 pt-3" aria-label={g.title}>
            <div className="flex items-baseline gap-2"><h3 className="text-[13.5px] font-semibold">{g.title}</h3><span className="text-xs text-[#5A6676]">{items.length}</span></div>
            <p className="mb-1 text-xs text-[#5A6676]">{g.why}</p>
            {items.map((f) => {
              const disabled = !f.redactable || office || done;
              return (
                <label key={f.id} className={`grid grid-cols-[18px_1fr] gap-2 rounded-lg px-2 py-1.5 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-[#F6F8FA]"}`}>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#163A5F]" checked={selected.has(f.id)} disabled={disabled} onChange={() => toggle(f)} />
                  <span>
                    <span className="flex flex-wrap items-baseline gap-1.5">
                      <b className="text-[13.5px] font-semibold">{labelOf(f)}</b>
                      <code className="rounded border border-[#E2E7EE] bg-[#F6F8FA] px-1 text-[12.5px]">{f.masked}</code>
                      {isNeeded(result, f) && <span className="text-[11.5px] text-[#1A7F4E]">this page asks for it</span>}
                    </span>
                    <span className="block text-xs text-[#5A6676]">{f.reason}{f.page !== null ? `, page ${f.page + 1}` : ""}</span>
                  </span>
                </label>
              );
            })}
          </section>
        );
      })}

      <div className="sticky bottom-0 mt-3 border-t border-[#E2E7EE] bg-white px-4 py-3">
        {done ? <p className="text-sm font-medium text-[#1A7F4E]">{STATUS_COPY[status as Exclude<TabStatus, "pending">]}</p> : (
          <>
            <p className="mb-2 text-xs text-[#5A6676]" aria-live="polite">
              The site will get <b className="font-semibold text-[#1B2A3A]">{keeps.length ? keeps.join(", ") : "the document with nothing personal left"}</b>{removed ? `. Removed: ${removed} item${removed === 1 ? "" : "s"}.` : "."}
            </p>
            <button onClick={onRedact} disabled={busy || office || removed === 0}
              className="w-full rounded-[10px] bg-[#163A5F] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#9AA7B6]">
              {busy ? "Removing and verifying…" : office ? "Word and Excel files can't be cleaned here" : removed ? `Redact selected and upload (${removed})` : "Select something to remove"}
            </button>
          </>
        )}
        {outcome && <p className="mt-2 text-xs text-[#1B2A3A]" role="status">{outcome}</p>}
      </div>
    </div>
  );
}

function Choice({ checked, onChange, title, sub }: { checked: boolean; onChange: () => void; title: string; sub: string }) {
  return (
    <label className="mt-1 flex cursor-pointer items-start gap-2">
      <input type="radio" className="mt-1 h-4 w-4 accent-[#163A5F]" checked={checked} onChange={onChange} />
      <span><span className="font-medium">{title}</span><span className="block text-xs text-[#5A6676]">{sub}</span></span>
    </label>
  );
}
