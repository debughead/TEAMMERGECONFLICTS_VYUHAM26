// Company policy (D-039): upload a policy JSON, pick which one is active, see its rules, export it.
import { useState } from "react";
import { activatePolicy, addPolicy, policyText, removePolicy, type PolicySummary } from "../engine/client.ts";

const ACTION_TEXT: Record<string, string> = { remove: "Remove", block: "Don't share", review: "Review", keep: "Allowed" };
const ACTION_STYLE: Record<string, string> = {
  remove: "bg-orange-100 text-orange-800", block: "bg-red-100 text-red-800", review: "bg-yellow-100 text-yellow-800", keep: "bg-emerald-50 text-emerald-800",
};

export function PolicyTab({ state, onChange }: { state: { active: string | null; list: PolicySummary[] } | null; onChange: () => void }) {
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  if (!state) return <p className="text-sm text-slate-600">Loading policies…</p>;
  const active = state.list.find((p) => p.id === state.active) ?? null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErrors([]);
    try { await fn(); onChange(); } catch (e) { setErrors([e instanceof Error ? e.message : "Something went wrong"]); } finally { setBusy(false); }
  };
  const upload = (f: File) => run(async () => {
    const r = await addPolicy(await f.text());
    if (!r.ok) setErrors(r.errors);
  });
  const download = async (p: PolicySummary) => {
    const text = await policyText(p.id);
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${p.name.replace(/[^\w-]+/g, "-").replace(/-+$/, "").toLowerCase()}-v${p.version}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border bg-white p-4">
        <h2 className="text-lg font-semibold">Company policy</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          A policy says what to remove from which kind of document, depending on where the file is going. For example: payslips sent outside lose
          pay and ID details; anything marked confidential never leaves the company. It's checked on this device; nothing is uploaded.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className={`cursor-pointer rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white ${busy ? "opacity-50" : ""}`}>
            Upload policy (JSON)
            <input type="file" accept=".json,application/json" className="hidden" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
          </label>
          {state.list.filter((p) => p.builtIn).map((p) => (
            <button key={p.id} disabled={busy} onClick={() => void download(p)} className="rounded-md border bg-white px-3 py-2 text-sm">Download the example to edit</button>
          ))}
          {active && <button disabled={busy} onClick={() => void run(() => activatePolicy(null))} className="rounded-md border bg-white px-3 py-2 text-sm">Turn policy off</button>}
        </div>
        {errors.length > 0 && (
          <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
            <p className="font-medium">This policy can't be used:</p>
            <ul className="mt-1 list-disc pl-5">{errors.map((e) => <li key={e}><code className="text-xs">{e}</code></li>)}</ul>
          </div>
        )}
      </section>

      {active ? <PolicyDetail p={active} /> : (
        <p className="rounded-lg border border-dashed bg-white p-4 text-sm text-slate-600">No policy is on. Scans use RedactGuard's own rules only. Turn on the example below or upload your own.</p>
      )}

      <section className="rounded-lg border bg-white">
        <h3 className="border-b px-4 py-2 text-sm font-semibold">Available policies</h3>
        <ul className="divide-y">
          {state.list.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span className="font-medium">{p.name}</span>
              <span className="text-slate-500">v{p.version}{p.builtIn ? ", built in" : ""}</span>
              <code className="text-xs text-slate-500" title={p.sha256}>{p.sha256.slice(0, 12)}</code>
              <span className="ml-auto flex gap-2">
                {state.active === p.id ? <span className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">On</span>
                  : <button disabled={busy} onClick={() => void run(() => activatePolicy(p.id))} className="rounded border px-2 py-0.5 text-xs">Turn on</button>}
                <button disabled={busy} onClick={() => void download(p)} className="rounded border px-2 py-0.5 text-xs">Export</button>
                {!p.builtIn && <button disabled={busy} onClick={() => void run(() => removePolicy(p.id))} className="rounded border px-2 py-0.5 text-xs text-red-700">Remove</button>}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function PolicyDetail({ p }: { p: PolicySummary }) {
  return (
    <section className="rounded-lg border bg-white">
      <div className="border-b px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="font-semibold">{p.name}</h3>
          <span className="text-sm text-slate-500">version {p.version}{p.owner ? `, owned by ${p.owner}` : ""}</span>
        </div>
        {p.description && <p className="mt-1 max-w-3xl text-sm text-slate-600">{p.description}</p>}
        <p className="mt-2 text-xs text-slate-500">
          Fingerprint <code title={p.sha256}>{p.sha256.slice(0, 16)}…</code>. Inside the company: {p.internalDomains.length ? p.internalDomains.join(", ") : "no domains listed"}.
          {p.dictionaries.length > 0 && <> Word lists: {p.dictionaries.map((d) => `${d.name} (${d.terms})`).join(", ")}.</>}
        </p>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr><th className="px-4 py-2 font-medium">Rule</th><th className="px-2 font-medium">Going outside</th><th className="px-2 font-medium">Going inside</th><th className="px-4 font-medium">Why</th></tr>
        </thead>
        <tbody>
          {p.rules.map((r) => (
            <tr key={r.id} className="border-t align-top">
              <td className="px-4 py-2 font-medium">{r.title}</td>
              <td className="px-2 py-2"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${ACTION_STYLE[r.outside]}`}>{ACTION_TEXT[r.outside]}</span></td>
              <td className="px-2 py-2"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${ACTION_STYLE[r.inside]}`}>{ACTION_TEXT[r.inside]}</span></td>
              <td className="px-4 py-2 text-slate-600">{r.clause}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
