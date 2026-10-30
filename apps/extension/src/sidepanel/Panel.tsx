// Side panel: the full review for the file picked in this tab (choose exactly what to remove), plus
// settings. Same vocabulary and grouping as the in-page card.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ScanContext, ScanResult, VerifyReport } from "@redactguard/core/schemas";
import { DEFAULT_SETTINGS, Settings, type TabStatus } from "../messages.ts";
import { RegionMap } from "./RegionMap.tsx";
import {
  actionLabel, defaultSelection, displayOf, GROUPS, identityKit, kitSentence, receipt, rowNote, rowsOf, rowState, toggleRow, VERDICT_COPY, type Row,
} from "../ui/groups.ts";

interface TabState { fileName: string; context: ScanContext; result: ScanResult; status: TabStatus }
type PanelReply = { ok: true; verify: VerifyReport; attached: boolean } | { ok: false; error: string };

const TONE = {
  stop: { band: "border-stop bg-stop-wash", title: "text-stop", bar: "bg-stop" },
  caution: { band: "border-caution bg-caution-wash", title: "text-caution", bar: "bg-caution" },
  clear: { band: "border-clear bg-clear-wash", title: "text-clear", bar: "bg-clear" },
} as const;
const STATUS_COPY: Record<Exclude<TabStatus, "pending">, string> = {
  "safe-uploaded": "Uploaded the verified copy.",
  "original-uploaded": "Uploaded the original. Your reason is in the audit log.",
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
      // E2E builds only: the panel opened as a tab for screenshots reviews the tab named in ?tab=.
      const forced = import.meta.env.MODE === "e2e" ? Number(new URLSearchParams(location.search).get("tab")) || null : null;
      const id = forced ?? tab?.id;
      if (id === undefined) return;
      setTabId(id);
      const s = (await chrome.runtime.sendMessage({ type: "tab-state", tabId: id })) as TabState | null;
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

  const removeSelected = async () => {
    if (!state || tabId === null) return;
    setBusy(true);
    setOutcome(null);
    const reply = (await chrome.runtime.sendMessage({ type: "panel-redact", tabId, scanId: state.result.scanId, selectedIds: [...selected] })) as PanelReply;
    setBusy(false);
    if (!reply.ok) return setOutcome(`Couldn't finish: ${reply.error}. Choose the file again on the page.`);
    if (!reply.verify.passed) return setOutcome("The cleaned copy failed verification, so nothing was uploaded.");
    setOutcome(reply.attached ? "Uploaded the verified copy. Nothing you removed can be recovered from it." : "Verified, but the page's upload field is gone. Choose the file again.");
  };

  return (
    <div className="flex min-h-screen flex-col bg-white text-[13.5px] leading-[1.45] text-ink [font-family:system-ui,-apple-system,'Segoe_UI',Roboto,sans-serif]">
      <header className="flex items-center gap-2 border-b border-rule px-4 py-2.5">
        <img src="/icons/icon32.png" width="18" height="18" alt="" />
        <h1 className="text-[14px] font-semibold">RedactGuard</h1>
        <span className="ml-auto text-[12px] text-muted">Runs on this device</span>
      </header>

      <main className="flex-1">
        {state ? <Review state={state} selected={selected} setSelected={setSelected} busy={busy} outcome={outcome} onRemove={removeSelected} />
          : <p className="px-4 py-6 text-muted">Choose a file in any upload field. RedactGuard checks it here before the site receives it.</p>}
      </main>

      <details className="group border-t border-rule px-4 py-3">
        <summary className="cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden">
          <span className="inline-block w-3 text-muted transition-transform group-open:rotate-90" aria-hidden>›</span> Settings
        </summary>
        <div className="mt-2 space-y-3 pl-3">
          <fieldset>
            <legend className="mb-1 font-medium">When a file has something to remove</legend>
            <Choice checked={settings.mode === "ask"} onChange={() => save({ ...settings, mode: "ask" })} title="Ask me" sub="Show what was found and let me choose." />
            <Choice checked={settings.mode === "auto"} onChange={() => save({ ...settings, mode: "auto" })} title="Clean automatically" sub="Remove location, file details and hidden text without asking. Anything else still asks." />
          </fieldset>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-[3px] h-4 w-4 accent-ink" checked={settings.aiOn} onChange={(e) => void toggleAi(e.target.checked)} />
            <span><span className="font-medium">AI review</span><span className="block text-[12px] text-muted">Claude Opus 5.5 with your own key. Only short lines are sent, with IDs, names and addresses replaced by placeholders.</span></span>
          </label>
          {settings.aiOn && (
            <input type="password" placeholder="Anthropic API key" aria-label="Anthropic API key" value={settings.aiKey} onChange={(e) => save({ ...settings, aiKey: e.target.value.trim() })}
              className="w-full rounded-md border border-rule px-2.5 py-1.5 focus:border-ink focus:outline-none" />
          )}
          <div>
            <p className="font-medium">Trusted sites</p>
            {settings.trusted.length === 0 ? <p className="text-[12px] text-muted">None. Trusting a site relaxes warnings there; blocks still apply.</p>
              : <ul className="mt-1 divide-y divide-rule">{settings.trusted.map((d) => (
                <li key={d} className="flex items-center justify-between py-1 text-[12.5px]">
                  <span>{d}</span>
                  <button className="font-medium text-ink underline decoration-rule underline-offset-2 hover:decoration-ink" onClick={() => save({ ...settings, trusted: settings.trusted.filter((x) => x !== d) })}>Stop trusting</button>
                </li>))}</ul>}
          </div>
        </div>
      </details>
    </div>
  );
}

function Review({ state, selected, setSelected, busy, outcome, onRemove }: {
  state: TabState; selected: Set<string>; setSelected: (s: Set<string>) => void; busy: boolean; outcome: string | null; onRemove: () => void;
}) {
  const { result, context, fileName, status } = state;
  const copy = VERDICT_COPY[result.verdict];
  const tone = TONE[copy.tone];
  const office = result.fileType === "docx" || result.fileType === "xlsx";
  const { keeps, removed } = useMemo(() => receipt(result, selected), [result, selected]);
  const kit = identityKit(result);
  const done = status !== "pending";

  return (
    <>
      <section className={`border-l-[3px] px-4 pb-3 pt-3 ${tone.band}`} aria-label="Verdict">
        <h2 className={`text-[16px] font-semibold leading-snug ${tone.title}`}>{copy.title}</h2>
        <p className="mt-0.5 truncate text-[12px] text-muted" title={fileName}>{fileName}, for {context.domain}</p>
        <div className="mt-2.5 flex items-center gap-2.5" title="How much this file exposes, from 0 to 100">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-rule" aria-hidden>
            <div className={`h-full ${tone.bar}`} style={{ width: `${Math.max(4, result.exposureScore)}%` }} />
          </div>
          <span className="text-[12px] text-muted [font-variant-numeric:tabular-nums]">Exposure {result.exposureScore} of 100</span>
        </div>
        {kit && <p className="mt-2 text-[12.5px]">{kitSentence(kit.masked)}</p>}
        {result.context && (
          <p className="mt-2 text-[12.5px] text-muted">
            The upload field asks for “{context.fieldLabel || "a file"}”.{" "}
            {result.context.expected ? "Items this page needs are left unticked." : "This page doesn't usually ask for this kind of document."}
          </p>
        )}
      </section>

      {GROUPS.map((g) => {
        const rows = rowsOf(result, g.id);
        if (!rows.length) return null;
        return (
          <section key={g.id} className="border-b border-rule px-4 py-3 last-of-type:border-b-0" aria-label={g.title}>
            <h3 className="font-semibold">{g.title} <span className="font-normal text-muted">({rows.length})</span></h3>
            <p className="text-[12px] text-muted">{g.why}</p>
            <ul className="mt-1.5">
              {rows.map((row) => <RowItem key={row.key} row={row} result={result} selected={selected} disabled={!row.f.redactable || office || done}
                onToggle={() => setSelected(toggleRow(row, selected))} />)}
            </ul>
            {g.id === "file" && result.gps && <RegionMap gps={result.gps} />}
          </section>
        );
      })}

      <div className="sticky bottom-0 border-t border-rule bg-white px-4 py-3">
        {done ? <p className="font-medium text-clear">{STATUS_COPY[status as Exclude<TabStatus, "pending">]}</p> : (
          <>
            <p className="mb-2 text-[12.5px] text-muted" aria-live="polite">
              {context.domain} gets <span className="text-ink">{keeps.length ? keeps.join(", ") : "the document with nothing personal in it"}</span>.
            </p>
            <button onClick={onRemove} disabled={busy || office || removed === 0}
              className="w-full rounded-md bg-ink px-4 py-2.5 font-semibold text-white hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:bg-[#a7b0bb]">
              {busy ? "Removing and verifying…" : office ? "Word and Excel files can't be cleaned here" : removed ? actionLabel(removed) : "Tick what to remove"}
            </button>
          </>
        )}
        {outcome && <p className="mt-2 text-[12.5px]" role="status">{outcome}</p>}
      </div>
    </>
  );
}

function RowItem({ row, result, selected, disabled, onToggle }: {
  row: Row; result: ScanResult; selected: Set<string>; disabled: boolean; onToggle: () => void;
}) {
  const state = rowState(row, selected);
  const note = rowNote(result, row);
  const shown = displayOf(row.f);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = state === "mixed"; }, [state]);
  return (
    <li>
      <label className={`-mx-2 grid grid-cols-[16px_1fr] gap-x-2.5 rounded-md px-2 py-1.5 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-wash"}`}>
        <input ref={box} type="checkbox" className="mt-[3px] h-4 w-4 accent-ink" checked={state === "on"} disabled={disabled} onChange={onToggle}
          aria-describedby={note ? `note-${row.ids[0]}` : undefined} />
        <span className="min-w-0">
          <span className="flex items-baseline justify-between gap-3">
            <span className="font-medium">{shown.label}</span>
            <span className="value" data-on={state === "on"} title={state === "on" ? "Will be removed" : "Will be sent"}>{shown.value}</span>
          </span>
          {note && <span id={`note-${row.ids[0]}`} className="block text-[12px] text-muted">{note}</span>}
        </span>
      </label>
    </li>
  );
}

function Choice({ checked, onChange, title, sub }: { checked: boolean; onChange: () => void; title: string; sub: string }) {
  return (
    <label className="mt-1 flex cursor-pointer items-start gap-2">
      <input type="radio" name="mode" className="mt-[3px] h-4 w-4 accent-ink" checked={checked} onChange={onChange} />
      <span><span className="font-medium">{title}</span><span className="block text-[12px] text-muted">{sub}</span></span>
    </label>
  );
}
