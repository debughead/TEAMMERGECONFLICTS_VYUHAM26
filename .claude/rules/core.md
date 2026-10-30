---
paths:
  - "packages/core/**"
---

# Rules for the shared core

- The core must run unchanged in a Web Worker, in Node (Vitest), and inside the extension's offscreen document. Do not import anything that needs the DOM, `window`, `chrome.*`, or the network.
- Public entry points are `scan()` and `redact()` in `src/index.ts`. `scan()` takes the file bytes plus options; `redact()` takes the `scanId` of an open session plus options (D-012). `redact()` always runs `verify()` on the output. Both return objects defined in `src/schemas.ts`.
- Raw values live only in the session map inside the worker. Functions that return data to the UI must return `masked` strings, never raw values. Add a test whenever a new return path is added.
- Every new detector needs: a unit test with a positive case, a negative case (a near-miss that must NOT match, e.g. 12 random digits failing Verhoeff), and an entry in at least one sample's expected JSON.
- Limits from `filetype.ts` (size, pages, megapixels, zip entries, compression ratio, 60 s timeout) are enforced before any heavy library opens the file. Never raise a limit without asking.
- `verify()` re-opens the output as a fresh document. Never reuse in-memory objects from the redaction step to "verify".
- Code in `src/ai/` only builds payloads and validates replies. It never performs the call; the host does.
- Deterministic rules come first. AI findings may only add items; they cannot remove or downgrade a rule-based finding.
