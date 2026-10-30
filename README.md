# RedactGuard

> Most tools hide your data. We prove it's gone.

RedactGuard finds sensitive data in documents (Aadhaar, PAN, card numbers, bank details, names, addresses, GPS and hidden metadata), removes it for real, and verifies that nothing recoverable is left.

It ships two ways, both using one TypeScript core:

- **Web Lab:** a static website. Drop a file to scan it, redact it, verify the result and download it.
- **Browser Guard:** a Chrome extension. It catches file uploads on any site, scans the file before the site sees it, and offers a cleaned, verified copy.

## Privacy model

- Everything runs in your browser: parsing, OCR, detection, redaction and verification. There is no server.
- AI (Claude) is **optional and off by default**. It uses your own API key and receives only placeholder text (`[AADHAAR_1]`, `[NAME_1]`). The UI shows exactly what was sent.
- The audit log records actions and keyed hashes, never the values.

## Docs

- [`docs/HLD.md`](docs/HLD.md): high- and low-level design
- [`docs/GUIDE.md`](docs/GUIDE.md): feature-by-feature build guide
- [`docs/DECISIONS.md`](docs/DECISIONS.md): decision log
- [`docs/PROGRESS.md`](docs/PROGRESS.md): build status
- [`CLAUDE.md`](CLAUDE.md): working rules for Claude Code in this repo

Built for problem statement AF-13 (Privacy Leakage Detection and Secure Redaction).
