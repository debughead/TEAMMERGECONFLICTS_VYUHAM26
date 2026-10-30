---
name: status
description: Report where the RedactGuard build stands right now. Use when the user types /status or asks what's done, what's next, how it's going, or what's blocked.
---

# Status report

Build the report only from facts you check now, not from memory of the conversation.

1. Read `docs/PROGRESS.md` and the last entries of `docs/DECISIONS.md`.
2. Run `git status --short` and `git log --oneline -10` (skip if not a git repo and say so).
3. Run the typecheck and test commands listed under "Commands" in `CLAUDE.md`. If they take longer than about 2 minutes, run only the core tests and say which you ran.
4. Reply in exactly this shape, under 25 lines:

**Overall:** one line (on track / at risk / blocked) and why
**Done since last update:** bullets, each tied to a file or commit
**In progress:** bullets
**Next up:** the next 1–3 items from PROGRESS.md
**Blockers / waiting on you:** questions that need the user's decision, each with options
**Health:** typecheck pass/fail · tests X passed / Y failed (command used) · spikes passed N/6
**Unverified assumptions:** anything still marked UNVERIFIED

5. If PROGRESS.md disagrees with what git or the tests show, say so and propose the correction. Don't edit it silently.
