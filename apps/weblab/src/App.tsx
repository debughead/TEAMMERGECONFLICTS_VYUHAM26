import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiRequest, AuditEvent, ChainCheck, ComplianceReport, Destination, RedactResult, ScanResult } from "@redactguard/core";
import { aiPayload, auditCheck, auditEvents, complianceFor, policies, redactScan, scanFile, type PolicySummary } from "./engine/client.ts";
import { PolicyTab } from "./components/PolicyTab.tsx";
import { FindingList } from "./components/FindingList.tsx";
import { GpsMap } from "./components/GpsMap.tsx";
import { VerifyReport } from "./components/VerifyReport.tsx";
import { XRay } from "./components/XRay.tsx";

type Tab = "lab" | "policy" | "audit";
const TAB_TEXT: Record<Tab, string> = { lab: "Scan & redact", policy: "Company policy", audit: "Audit log" };
const KEY_STORAGE = "rg-ai-key";
const VERDICT_STYLE = { block: "bg-red-600", warn: "bg-amber-500", allow: "bg-emerald-600" } as const;

export function App() {
  const [tab, setTab] = useState<Tab>("lab");
  const [policyState, setPolicyState] = useState<{ active: string | null; list: PolicySummary[] } | null>(null);
  const refreshPolicies = useCallback(() => { void policies().then(setPolicyState); }, []);
  useEffect(refreshPolicies, [refreshPolicies]);
  const activePolicy = policyState?.list.find((p) => p.id === policyState.active) ?? null;
  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" width="44" height="44" alt="" />
          <div>
          <h1 className="text-2xl font-bold">RedactGuard Web Lab</h1>
          <p className="text-sm text-slate-600">Most tools hide your data. We prove it's gone. Everything runs in this browser tab.</p>
          </div>
        </div>
        <nav className="flex gap-2">
          {(["lab", "policy", "audit"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-slate-900 text-white" : "bg-white border"}`}>
              {TAB_TEXT[t]}
            </button>
          ))}
        </nav>
      </header>
      {tab === "lab" ? <Lab policy={activePolicy} onOpenPolicy={() => setTab("policy")} />
        : tab === "policy" ? <PolicyTab state={policyState} onChange={refreshPolicies} /> : <Audit />}
    </div>
  );
}

function Lab({ policy, onOpenPolicy }: { policy: PolicySummary | null; onOpenPolicy: () => void }) {
  const [destination, setDestination] = useState<Destination>("outside");
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redacted, setRedacted] = useState<RedactResult | null>(null);
  const [aiOn, setAiOn] = useState(false);
  const [aiKey, setAiKey] = useState(() => sessionStorage.getItem(KEY_STORAGE) ?? localStorage.getItem(KEY_STORAGE) ?? "");
  const [rememberKey, setRememberKey] = useState(() => localStorage.getItem(KEY_STORAGE) !== null);
  const [watermark, setWatermark] = useState({ on: false, domain: "", purpose: "" });
  const [payload, setPayload] = useState<AiRequest | null>(null);

  useEffect(() => {
    // Session-only by default; "remember" is an explicit choice with a warning.
    sessionStorage.setItem(KEY_STORAGE, aiKey);
    if (rememberKey) localStorage.setItem(KEY_STORAGE, aiKey);
    else localStorage.removeItem(KEY_STORAGE);
  }, [aiKey, rememberKey]);

  const onFile = useCallback(async (f: File) => {
    setError(null); setResult(null); setRedacted(null); setPayload(null); setReport(null);
    const bytes = new Uint8Array(await f.arrayBuffer());
    setFile({ name: f.name, bytes });
    setBusy(aiOn ? "Scanning (AI on: masked lines will be sent)…" : "Scanning on this device…");
    try {
      const r = await scanFile(bytes, {
        options: { profile: "lab", context: null, ocrPageCap: 50, trustedSite: false },
        destination,
        ...(aiOn && aiKey ? { aiKey } : {}),
      });
      const rep = policy ? await complianceFor(r.scanId) : null;
      setResult(r);
      setReport(rep);
      // Everything removable is ticked, except what the company policy explicitly allows to stay.
      const allowed = new Set(rep?.items.filter((i) => i.action === "keep").map((i) => i.findingId) ?? []);
      setSelected(new Set(r.findings.filter((x) => x.redactable && !allowed.has(x.id)).map((x) => x.id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setBusy(null);
    }
  }, [aiOn, aiKey, destination, policy]);

  const quickSelect = () => result && setSelected(new Set(result.findings.filter((f) => f.redactable && (f.severity === "critical" || f.severity === "high" || f.autoCleanable)).map((f) => f.id)));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const doRedact = async () => {
    if (!result) return;
    setBusy("Removing and verifying…"); setError(null);
    try {
      const wm = watermark.on && result.fileType === "pdf" && watermark.domain
        ? { domain: watermark.domain, purpose: watermark.purpose || "the stated purpose", date: new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) }
        : null;
      setRedacted(await redactScan(result.scanId, { selectedIds: [...selected], watermark: wm }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Redaction failed");
    } finally {
      setBusy(null);
    }
  };

  const download = () => {
    if (!redacted?.bytes || !file) return;
    const url = URL.createObjectURL(new Blob([redacted.bytes as Uint8Array<ArrayBuffer>], { type: redacted.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file.name.replace(/\.[^.]+$/, "")}-${redacted.filename}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const counts = useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of result?.findings ?? []) c[f.severity]++;
    return c;
  }, [result]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
      <section className="space-y-4">
        {policy ? (
          <fieldset className="rounded-lg border bg-white p-3 text-sm">
            <legend className="px-1 text-xs text-slate-500">
              Company policy: <button onClick={onOpenPolicy} className="underline">{policy.name}</button> v{policy.version}
            </legend>
            <p className="mb-2 text-slate-600">Where is this file going?</p>
            <div className="flex flex-wrap gap-4">
              {([["outside", "Outside the company"], ["inside", "Inside the company"]] as const).map(([v, label]) => (
                <label key={v} className="flex items-center gap-2">
                  <input type="radio" name="destination" checked={destination === v} onChange={() => setDestination(v)} disabled={!!busy} /> {label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="text-xs text-slate-500">No company policy is on. <button onClick={onOpenPolicy} className="underline">Turn one on</button> to apply your organisation's rules.</p>
        )}
        <DropZone onFile={onFile} disabled={!!busy} />
        <details className="rounded-lg border bg-white p-3 text-sm">
          <summary className="cursor-pointer font-medium">AI review (optional, off): {aiOn ? "on" : "off"}</summary>
          <div className="mt-2 space-y-2">
            <p className="text-slate-600">Uses Claude Opus 5.5 with your own Anthropic key. Only selected lines are sent, with every ID, name and address replaced by placeholders. You can see exactly what was sent.</p>
            <label className="flex items-center gap-2"><input type="checkbox" checked={aiOn} onChange={(e) => setAiOn(e.target.checked)} /> Turn on AI review</label>
            <input type="password" placeholder="sk-ant-…" value={aiKey} onChange={(e) => setAiKey(e.target.value.trim())} className="w-full rounded border px-2 py-1" />
            <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={rememberKey} onChange={(e) => setRememberKey(e.target.checked)} /> Remember the key on this device (stored in this browser's local storage)</label>
          </div>
        </details>
        {busy && <p className="rounded bg-slate-900 p-3 text-sm text-white">{busy}</p>}
        {error && <p className="rounded bg-red-100 p-3 text-sm text-red-800">{error}</p>}
        {result && (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white p-3">
              <span className={`rounded px-2 py-1 text-sm font-bold uppercase text-white ${VERDICT_STYLE[result.verdict]}`}>{result.verdict}</span>
              <span className="text-sm">Exposure <b>{result.exposureScore}</b>/100</span>
              <span className="text-xs text-slate-600">{counts.critical} critical · {counts.high} high · {counts.medium} medium · {counts.low} low</span>
              {result.ocr.pagesTotal > 0 && <span className="text-xs text-slate-600">OCR {result.ocr.pagesDone}/{result.ocr.pagesTotal} page(s)</span>}
            </div>
            {result.warnings.map((w) => <p key={w} className="rounded bg-amber-50 p-2 text-xs text-amber-900">{w}</p>)}
            {report && <PolicyBanner report={report} />}
            <FindingList findings={result.findings} selected={selected} onToggle={toggle} policyItems={report?.items ?? []} />
            {result.ai.payloadIds.length > 0 && (
              <div className="text-sm">
                What was sent to AI:{" "}
                {result.ai.payloadIds.map((id) => (
                  <button key={id} className="mr-2 underline" onClick={async () => setPayload(await aiPayload(result.scanId, id))}>{id}</button>
                ))}
                {payload && <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{payload.user}</pre>}
              </div>
            )}
            {result.fileType === "pdf" && (
              <div className="space-y-2 rounded-lg border bg-white p-3 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={watermark.on} onChange={(e) => setWatermark({ ...watermark, on: e.target.checked })} /> Add a purpose watermark</label>
                {watermark.on && (
                  <div className="flex gap-2">
                    <input placeholder="Shared with (e.g. bank.example)" value={watermark.domain} onChange={(e) => setWatermark({ ...watermark, domain: e.target.value })} className="flex-1 rounded border px-2 py-1" />
                    <input placeholder="Purpose (e.g. KYC only)" value={watermark.purpose} onChange={(e) => setWatermark({ ...watermark, purpose: e.target.value })} className="flex-1 rounded border px-2 py-1" />
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={quickSelect} className="rounded-md border bg-white px-3 py-2 text-sm">Quick select (critical, high, hidden)</button>
              <button onClick={doRedact} disabled={!!busy || selected.size === 0} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
                Remove {selected.size} item(s) and verify
              </button>
            </div>
            {redacted && (
              <div className="space-y-2">
                <VerifyReport report={redacted.verify} />
                {redacted.bytes && (
                  <button onClick={download} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white">
                    {report?.blockedBy ? "Download verified file (internal use only)" : "Download verified file"}
                  </button>
                )}
                {redacted.unredacted.length > 0 && <p className="text-xs text-slate-600">{redacted.unredacted.length} selected item(s) couldn't be removed in this format.</p>}
              </div>
            )}
          </>
        )}
      </section>
      <section>
        {file && result?.fileType === "pdf" && <XRay bytes={file.bytes} findings={result.findings} selected={selected} />}
        {result?.gps && <GpsMap gps={result.gps} />}
      </section>
    </div>
  );
}

const ACTION_WORD = { remove: "remove", block: "don't share", review: "review", keep: "allowed" } as const;

function PolicyBanner({ report }: { report: ComplianceReport }) {
  const where = report.destination === "outside" ? "going outside the company" : "staying inside the company";
  return (
    <div className={`rounded-lg border p-3 text-sm ${report.blockedBy ? "border-red-300 bg-red-50" : "bg-white"}`}>
      {report.blockedBy ? (
        <p className="font-semibold text-red-800">Company policy: don't share this file {report.destination === "outside" ? "outside the company" : "at all"}.</p>
      ) : (
        <p className="font-medium">Company policy for a file {where}</p>
      )}
      {report.blockedBy && <p className="mt-0.5 text-red-800">{report.blockedBy.title}: {report.blockedBy.clause}</p>}
      {report.matchedRules.length ? (
        <ul className="mt-2 space-y-1 text-slate-700">
          {report.matchedRules.map((m) => (
            <li key={m.id}><span className="font-medium">{m.title}</span> ({ACTION_WORD[m.action]}): {m.because.startsWith("found") ? m.because : `this document ${m.because}`}.</li>
          ))}
        </ul>
      ) : <p className="mt-1 text-slate-600">No rule in "{report.policy.name}" applies to this document.</p>}
    </div>
  );
}

function DropZone({ onFile, disabled }: { onFile: (f: File) => void; disabled: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f && !disabled) onFile(f); }}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center ${over ? "border-slate-900 bg-slate-100" : "border-slate-300 bg-white"}`}
    >
      <span className="font-medium">Drop a PDF, photo, Word or Excel file</span>
      <span className="text-xs text-slate-500">It's processed in this tab and never uploaded.</span>
      <input type="file" className="hidden" disabled={disabled} accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </label>
  );
}

function Audit() {
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const [chain, setChain] = useState<ChainCheck | null>(null);
  useEffect(() => { void auditEvents().then(setRows); void auditCheck().then(setChain); }, []);
  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "redactguard-audit.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className={`rounded px-2 py-1 text-sm font-semibold text-white ${chain?.ok ? "bg-emerald-600" : "bg-red-600"}`}>
          {chain ? (chain.ok ? `Chain intact ✓ (${chain.count} rows)` : `Chain broken at row ${chain.firstBroken}`) : "Checking…"}
        </span>
        <button onClick={exportJson} className="rounded border bg-white px-3 py-1 text-sm">Export JSON</button>
        <span className="text-xs text-slate-500">Values are stored only as keyed hashes; the key never leaves this browser.</span>
      </div>
      <div className="overflow-auto rounded-lg border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr><th className="p-2">#</th><th>Time</th><th>Action</th><th>Item</th><th>Page</th><th>Value hash</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.seq} className="border-t">
                <td className="p-2">{r.seq}</td><td>{new Date(r.ts).toLocaleString()}</td><td>{r.action}</td>
                <td>{r.itemType ?? ""}</td><td>{r.page !== null ? r.page + 1 : ""}</td>
                <td className="font-mono text-xs">{r.valueHmac?.slice(0, 12) ?? ""}</td><td className="text-xs text-slate-600">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
