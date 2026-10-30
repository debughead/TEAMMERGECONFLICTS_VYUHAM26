import type { VerifyReport as Report } from "@redactguard/core";

const LABEL: Record<string, string> = {
  no_text_in_redacted_areas: "Nothing readable left in removed areas",
  no_removed_values_remain: "Removed values can't be found anywhere",
  metadata_empty: "Metadata cleared",
  single_revision: "No earlier versions inside the file",
  no_annots_embeds_js: "No annotations, attachments or scripts",
  no_image_metadata: "No image metadata",
};

export function VerifyReport({ report }: { report: Report }) {
  return (
    <div className={`rounded-lg border p-4 ${report.passed ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}>
      <p className="text-lg font-semibold">
        {report.passed ? `Verified: ${report.recoverableItems} recoverable items` : "Verification failed: the file was not released"}
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {report.checks.map((c) => (
          <li key={c.name} className="flex gap-2">
            <span aria-hidden>{c.passed ? "✓" : "✗"}</span>
            <span><span className="font-medium">{LABEL[c.name] ?? c.name}</span> <span className="text-slate-500">— {c.detail}</span></span>
          </li>
        ))}
      </ul>
      <p className="mt-2 break-all text-xs text-slate-500">Output SHA-256: {report.outputSha256}</p>
    </div>
  );
}
