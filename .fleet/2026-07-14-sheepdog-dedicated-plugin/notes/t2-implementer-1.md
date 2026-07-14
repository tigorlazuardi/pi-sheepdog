# Ticket 2 implementer notes

- Added local human wake formatting in `extensions/sheepdog.ts` with today/tomorrow/weekday/month(+year) output while leaving persisted `wakeAt` values as UTC ISO in state.
- Replaced human-facing wake displays in the footer, panel/list output, and follow-up notification message with the local formatter.
- Added `scripts/self-check.mjs` plus `npm run self-check -- time` coverage for today, tomorrow, weekday, same-year far date, and cross-year formatting.
- Acceptance check status: `npm --prefix ... run self-check -- time` passed; `npm --prefix ... run check` failed because `docs` build could not find `astro` (`sh: line 1: astro: command not found`).
