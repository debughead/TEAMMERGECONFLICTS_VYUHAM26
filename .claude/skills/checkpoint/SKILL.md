---
name: checkpoint
description: Close out a chunk of RedactGuard work safely. Use when the user types /checkpoint, says "wrap this up", or a task in PROGRESS.md is finished.
---

# Checkpoint

1. Run the typecheck and the relevant tests (commands in `CLAUDE.md`). If anything fails, stop here and report; do not continue the checkpoint.
2. Check the Definition of done in `CLAUDE.md` item by item and list which pass.
3. Search the changed files for raw-looking IDs (12-digit numbers, PAN patterns) and `console.log` of document content. Report anything found.
4. Update `docs/PROGRESS.md`: move finished items to Done (with date), set the next items, refresh Blockers and Open questions.
5. Add any newly confirmed library calls to `docs/VERIFIED_APIS.md`.
6. If a decision was made during this chunk, make sure it's in `docs/DECISIONS.md`.
7. Show the user `git diff --stat` and a proposed commit message. Commit only after the user says yes. Never push.
8. Finish with the end-of-task summary format from `CLAUDE.md`.
