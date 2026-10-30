// Leak X-Ray: renders the original PDF in the browser and outlines where findings sit. Hidden ones
// (under boxes, unapplied marks) glow red. Only rectangles come from the engine; no values.
import { useEffect, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Finding } from "@redactguard/core";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const HIDDEN = new Set(["under_black_box", "black_highlight", "unapplied_annot"]);
const SCALE = 1.25;

export function XRay({ bytes, findings, selected }: { bytes: Uint8Array; findings: Finding[]; selected: Set<string> }) {
  const [pages, setPages] = useState<{ index: number; url: string; w: number; h: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Copy: PDF.js transfers the buffer to its worker.
        const task = pdfjs.getDocument({ data: bytes.slice() });
        const doc = await task.promise;
        const out: typeof pages = [];
        for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: SCALE });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvas, viewport }).promise;
          out.push({ index: i - 1, url: canvas.toDataURL("image/png"), w: viewport.width, h: viewport.height });
        }
        if (!cancelled) setPages(out);
        await task.destroy();
      } catch {
        if (!cancelled) setError("Preview unavailable for this PDF");
      }
    })();
    return () => { cancelled = true; };
  }, [bytes]);

  if (error) return <p className="text-sm text-slate-500">{error}</p>;
  if (!pages.length) return <p className="text-sm text-slate-500">Rendering preview…</p>;
  return (
    <div className="space-y-4">
      {pages.map((p) => (
        <div key={p.index} className="relative mx-auto shadow" style={{ width: p.w, height: p.h }}>
          <img src={p.url} width={p.w} height={p.h} alt={`Page ${p.index + 1}`} className="block" />
          {findings.filter((f) => f.page === p.index).flatMap((f) =>
            f.rects.map((r, k) => {
              const hidden = HIDDEN.has(f.source);
              return (
                <div
                  key={`${f.id}-${k}`}
                  title={f.reason}
                  className={`absolute rounded-sm ${hidden ? "xray-hidden" : "border-2 border-amber-500/80"} ${selected.has(f.id) ? "" : "opacity-40"}`}
                  style={{ left: r[0] * SCALE - 2, top: r[1] * SCALE - 2, width: (r[2] - r[0]) * SCALE + 4, height: (r[3] - r[1]) * SCALE + 4 }}
                />
              );
            }),
          )}
        </div>
      ))}
    </div>
  );
}
