# Handover — pi-sheepdog extraction

## Provenance

- Source extension: `/home/homeserver/.pi/agent/extensions/rate-limit-wakeup.ts`
- Source spec: `/home/homeserver/.pi/agent/extensions/rate-limit-wakeup.SPEC.md`
- Both were **copied**, not moved. The originals under
  `/home/homeserver/.pi/agent/extensions/` are untouched — this task only
  wrote files under `/home/homeserver/projects/pi-sheepdog/`.

## What was copied / changed

- `extensions/sheepdog.ts` — exact copy of `rate-limit-wakeup.ts`, with one
  cosmetic rename in the top-of-file banner comment (`rate-limit-wakeup:` →
  `pi-sheepdog (rate-limit-wakeup):`). No other code changes:
  - Command names (`/rate-limit-wakeup`, `/rate-limit-wakeup-set`,
    `/rate-limit-wakeup-clear`, `/rate-limit`) are unchanged, so existing
    muscle memory / scripts keep working.
  - State path (`~/.pi/agent/.cache/rate-limit-wakeup/state.json`) and the
    footer status key (`"rate-limit-wakeup"`) are unchanged for the same
    reason — renaming these would be pure churn with no benefit and would
    silently orphan any state file already on disk.
  - Imports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`)
    were **not** changed — see "peer dependency scope" below.
- `docs/SPEC.md` — copy of the source spec, with:
  - Title/status line updated to note this is now historical design
    rationale (the described features are already implemented in
    `extensions/sheepdog.ts`), not a pending TODO.
  - The "Implementation environment (Opsi A — work in chezmoi source)"
    section relabeled as historical/pre-extraction context, with a note that
    this repo is now the actual source of truth and there's no chezmoi
    round-trip anymore.

## Peer dependency scope — deviation from the task brief

The task brief said to use `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`,
`@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, and `typebox`,
citing "current public docs."

I fetched the actual current docs
(`packages/coding-agent/docs/packages.md` in `earendil-works/pi`, the pi
source repo) and they state:

> Pi bundles core packages for extensions and skills. If you import any of
> these, list them in `peerDependencies` with a `"*"` range and do not
> bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
> `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.

This also matches what's actually installed locally (`~/.bun/install/cache`
has `@earendil-works/pi-coding-agent@0.80.6` as the current version vs.
`@mariozechner/pi-coding-agent@0.73.1` as an older one) and matches the
source extension's own imports, which already use `@earendil-works/*`.

**Decision:** used `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox` (all
`"*"`) in `package.json`'s `peerDependencies`. This required zero import
changes in `sheepdog.ts`. If `@mariozechner/*` is actually the intended
publish target for some other reason, that's a one-line `package.json` edit
plus a find/replace on the two import lines — flagging here rather than
guessing further.

## Package structure

```
pi-sheepdog/
  package.json       — name, peerDeps, pi.extensions manifest, pi-package keyword
  README.md           — install, commands, state path, caveats
  HANDOVER.md         — this file
  extensions/
    sheepdog.ts        — the extension (copied, lightly annotated)
  docs/
    SPEC.md             — adapted design spec (historical + current-state notes)
  .gitignore
```

`package.json`'s `pi.extensions` is `["./extensions"]` — a directory pointer
that pi auto-discovers `.ts`/`.js` files from, per the packages doc. No
build step: pi loads TypeScript directly via jiti, no bundler/tsconfig
needed for runtime use.

## Validation performed

- `npm pack --dry-run` — clean, produces a 4-file, ~18 KB tarball
  (`package.json`, `README.md`, `docs/SPEC.md`, `extensions/sheepdog.ts`).
- **Typecheck**: ran `tsc --noEmit` against `extensions/sheepdog.ts` with a
  temp `node_modules/@earendil-works/{pi-coding-agent,pi-tui,pi-agent-core,pi-ai}`
  and `node_modules/@types/node` symlinked in from the local bun install
  cache (`~/.bun/install/cache/...`), plus a throwaway tsconfig. **Passed
  with zero errors.** The symlinked `node_modules/` was deleted afterward —
  it is not part of this package (peer deps are provided by the pi runtime
  at install time, not bundled), and `.gitignore` excludes `node_modules/`
  regardless.
- Did not run an actual `pi install` / smoke-load inside a live pi session —
  no pi runtime harness was available in this task's sandbox to do that
  safely without touching the global `~/.pi/agent` config.

## Known caveats (carried into README)

- State file compatibility: since the state path and command names are
  unchanged from the original extension, if a user runs both
  `rate-limit-wakeup` (global) and `pi-sheepdog` (this package) at once,
  they'd share the same state file and command names, effectively
  colliding. Not a concern for the stated goal (dedicated standalone repo
  replacing the ad-hoc one) but worth knowing before enabling both
  simultaneously.
- `/rate-limit` overlay panel is read-only (no resume-now/delete actions) —
  inherited limitation from the source spec, not something this extraction
  changed.
- No npm publish has been done. This is a git-installable package only for
  now (`pi install git:github.com/tigorlazuardi/pi-sheepdog`).

## Git

- `git init` run in `/home/homeserver/projects/pi-sheepdog`, initial commit
  made with all files above. See commit hash in the task's final summary.
- **No GitHub repo was created** and **no remote was added/pushed** — per
  instructions, the main agent creates `tigorlazuardi/pi-sheepdog` on GitHub
  and pushes after reviewing this handover.

## Next steps (for main agent)

1. Review this handover, especially the peer-dependency scope decision
   above.
2. Create the GitHub repo `tigorlazuardi/pi-sheepdog` (public, matching
   `package.json`'s `repository` field).
3. `git remote add origin git@github.com:tigorlazuardi/pi-sheepdog.git` (or
   https) and push.
4. Optional: smoke-test with `pi install git:github.com/tigorlazuardi/pi-sheepdog`
   once pushed, and/or local path install
   (`pi install /home/homeserver/projects/pi-sheepdog`) before that.
