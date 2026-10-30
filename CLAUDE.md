# RedactGuard: instructions for Claude Code

RedactGuard finds sensitive data in documents, removes it for real, and proves it is gone, entirely in the browser.
One shared TypeScript core (`packages/core`) runs inside two apps: a static Web Lab (`apps/weblab`) and a Chrome MV3 extension (`apps/extension`).
Full design: `docs/HLD.md`. Feature-by-feature walkthrough: `docs/GUIDE.md`. Read the relevant section before starting a feature; don't work from memory of them.

## Non-negotiable product rules

- `packages/core` never touches the network or the DOM: no `fetch`, `XMLHttpRequest`, `WebSocket`, `document`, `window`. AI calls arrive only through an injected `aiClient` callback from the host app.
- Raw sensitive values (Aadhaar, PAN, card numbers, names, addresses) stay in worker memory. Never log them, never put them in UI state, test snapshots, audit rows or error messages. UI gets masked strings and rectangles only.
- No redacted file is ever released unless `verify()` passes all six checks. There is no override.
- AI is off by default, uses the user's own key, and receives placeholder text only (`[AADHAAR_1]`, `[NAME_1]`). AI can add findings but never lower a severity or a verdict.
- The extension ships no remote code. MuPDF and Tesseract files are bundled. Permissions stay `storage`, `sidePanel`, `offscreen` (+ optional Anthropic host permission).
- Text from a web page or a document can never lower a verdict.

## Ground truth, not memory (avoid hallucination)

- Before calling any third-party API (MuPDF.js, PDF.js, Tesseract.js, exifr, JSZip, compromise, Comlink, idb, zod, Leaflet, Chrome extension APIs), confirm the exact name and signature from the installed package's type definitions (`node_modules/<pkg>/**/*.d.ts`) or its official docs. Record what you confirmed in `docs/VERIFIED_APIS.md`.
- If you cannot verify an API, say "UNVERIFIED" and stop to ask. Do not guess a signature and move on.
- The code snippets in `docs/GUIDE.md` are simplified sketches. Treat their function names as hints to verify, not facts.
- Search the repo before referring to any file, function, script, config key or flag. Never invent one.
- Never say something works without running it. Report the exact command and its result.
- Never delete, skip, or loosen a test to make it pass. If a test looks wrong, explain why and ask.
- In every report, separate **Verified** (ran it / read it) from **Assumed** (not yet checked).
- Fragile areas need a passing spike before anything is built on them: side panel opening from a click, MuPDF filled-shape detection, Tesseract inside the extension, the re-attach loop guard, EXIF orientation, file size over messaging. Spike results go in `docs/DECISIONS.md`.

## Keep me informed

- **Start of a task:** restate the goal in 1–2 lines. For anything touching more than 3 files or more than one package, show a numbered plan and wait for my approval before editing.
- **During work:** keep the task list updated. After each meaningful step, give a 1–3 line update: done, next, any blocker.
- **End of a task**, always in this format:
  - **What changed:** files and a one-line purpose each
  - **How I verified:** commands run and their results
  - **Assumed / not verified:** anything still unchecked
  - **Next step:** one suggestion
- Then update `docs/PROGRESS.md` (status, what's done, what's next, blockers, open questions).
- If you get stuck after two attempts at the same problem, stop and tell me what you tried instead of trying a third variation silently.

## Stop and ask before

1. Adding, removing or upgrading any dependency.
2. Changing the shared contract in `packages/core/src/schemas.ts`.
3. Changing the extension manifest: permissions, host permissions, CSP, content-script matching.
4. Anything that adds a network request anywhere.
5. Deleting files, renaming packages, or rewriting more than ~150 lines of existing code.
6. Deviating from `docs/HLD.md` or choosing between two valid approaches with lasting effect.
7. Switching a fragile area to its fallback after a failed spike.
8. Changing expected values in tests or sample `expected-findings` JSON.
9. Any security trade-off (weaker limit, skipped check, broader permission).
10. `git push`, force operations, rebase, reset, or branch deletion.

How to ask: give options (A/B), your recommendation, the impact of each, and whether it is reversible. After I decide, log it in `docs/DECISIONS.md`.

## Repo map

- `packages/core/src/`: `index.ts` (scan/redact/verify), `schemas.ts`, `filetype.ts`, `extract/`, `detect/`, `ai/`, `score.ts`, `policy.ts`, `redact/`, `watermark.ts`, `verify.ts`, `audit/`, `worker.ts`
- `packages/ui/`: shared React components (FindingList, XRay, GpsMap, VerifyReport, AiPayloadViewer)
- `apps/weblab/`: static site. `apps/extension/`: `content/`, `background/`, `offscreen/`, `sidepanel/`, `lab/`
- `demo-sites/`: mock job portal, mock bank KYC page
- `samples/`: fake-data test files + `*.expected.json`

## Commands

- Install: `pnpm install`
- Typecheck all: `pnpm typecheck`
- Test all: `pnpm test` · core only: `pnpm --filter @redactguard/core test`
- Regenerate fake samples: `pnpm samples` (writes `samples/*` and `*.expected.json`)
- Independent cross-checks (installed via Homebrew): `pdftotext`, `pdfinfo`, `exiftool`, `tesseract`
- Web Lab dev server: `pnpm --filter weblab dev` · production build: `pnpm --filter weblab build`
- Web Lab browser self-test: `RG_SELFTEST=1 vite build` + `RG_SELFTEST=1 vite preview` in `apps/weblab`, open `/selftest.html` (report → `apps/weblab/.selftest-result.json`)
- Extension build: `pnpm --filter extension build`, then load `apps/extension/dist` unpacked in Chrome
- Extension e2e build (trace to the demo server, never shipped): `pnpm --filter extension build:e2e` → `apps/extension/dist-e2e`
- Demo sites: `pnpm demo` → http://localhost:8080/job-portal/ and /bank-kyc/ (`?autotest=<sample>` simulates a file pick)

## Coding conventions

- TypeScript strict mode; no `any` (use `unknown` and narrow). Validate data crossing a boundary (worker, messaging, AI reply) with zod.
- Core functions are small and pure where possible; side effects live in hosts.
- Tests live in `packages/core/test/`; every detector and validator gets unit tests; every sample file gets a golden test.
- Only fake data in samples and tests. Never real Aadhaar/PAN numbers.
- No `console.log` of document content; production builds strip logs.
- Comments explain *why*, not what.

## Definition of done

Typecheck passes · relevant tests pass · golden samples pass · any redaction path passes `verify()` · `docs/PROGRESS.md` updated · new APIs recorded in `docs/VERIFIED_APIS.md`.
