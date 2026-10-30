import type { Finding, Severity } from "@redactguard/core";

const SEV: Record<Severity, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-yellow-100 text-yellow-800",
  low: "bg-slate-100 text-slate-700",
};
const SOURCE: Record<string, string> = {
  under_black_box: "Hidden under a black box",
  black_highlight: "Blacked out, still text",
  unapplied_annot: "Redaction never applied",
  old_version: "In an earlier version",
  metadata: "File metadata",
  hidden_office: "Hidden in the document",
  ocr: "Read from the image",
  claude: "Found by AI",
  combination: "Combination risk",
  text: "Visible text",
};

export function FindingList({ findings, selected, onToggle }: {
  findings: Finding[]; selected: Set<string>; onToggle: (id: string) => void;
}) {
  if (!findings.length) return <p className="text-sm text-slate-600">No sensitive data found.</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
      {findings.map((f) => (
        <li key={f.id} className="flex items-start gap-3 p-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={selected.has(f.id)}
            disabled={!f.redactable}
            onChange={() => onToggle(f.id)}
            aria-label={`Remove ${f.type}`}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${SEV[f.severity]}`}>{f.severity}</span>
              <span className="font-medium capitalize">{f.type.replace(/_/g, " ")}</span>
              <code className="rounded bg-slate-100 px-1.5 text-sm">{f.masked}</code>
              <span className="text-xs text-slate-500">{SOURCE[f.source] ?? f.source}{f.page !== null ? ` · page ${f.page + 1}` : ""}</span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{f.reason}</p>
            {!f.redactable && <p className="mt-1 text-xs text-slate-500">Can't be removed here. Export to PDF and scan that to redact it.</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}
