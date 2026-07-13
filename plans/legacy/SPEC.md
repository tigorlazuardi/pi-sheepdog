# pi-sheepdog (rate-limit-wakeup) — manual set + multi-scope TUI (SPEC draft)

Status: historical design notes, carried over from the source extension this
package was extracted from. The features described here (manual set,
multi-scope state v2, wall-clock footer, read-only `/rate-limit` panel) are
already implemented in `extensions/sheepdog.ts` — this document is kept as
provenance/design rationale, not a pending TODO list.

## Goal

1. Manual command to schedule a wakeup by hand.
2. Footer shows wall-clock time, not only duration.
3. `rate-limit` text becomes an entry point to a TUI panel showing all scopes.

---

## Decisions locked by user

- Time semantic (V1) = **relative duration ONLY**. Absolute datetime = deferred to later phase.
- **No dayjs** for V1. Dependency-free: reuse/extend `parseDurationMs`.
- Duration units = **d / h / m / s** (added `d` = days).
- Timezone = **host machine local timezone** (only relevant once absolute lands / for footer wall-clock).
- Footer = show **wall-clock** wake time (plus duration).
- `rate-limit` = door into a TUI detail view for **multiple scopes**.

---

## ⚠️ Architecture collision to resolve FIRST

Current extension = **single global timer** (one `wakeAt`, one `state.json`, one `setTimeout`).

But new asks imply **multiple concurrent scopes**:

- `/rate-limit-wakeup-set <time> [scope]` with a scope arg ⇒ user can set several scopes.
- TUI "show various scopes" ⇒ list > 1 pending wake.
- Real life: `omniroute/cx/*` limited AND `omniroute/cc/*` limited at same time.

So single-global-timer must become **multi-entry, keyed by scope**.

### New state shape (v2)

```txt
state.json (v2)
{
  "version": 2,
  "entries": {
    "omniroute/cx/*": {
      "scopeGlob": "omniroute/cx/*",
      "modelRef": "omniroute/cx/gpt-5.4",
      "wakeAt": "2026-07-10T15:30:00+07:00",
      "delayMs": 5367000,
      "status": "pending",
      "source": "provider-429 | agent_end | manual",
      "sourceExcerpt": "...",
      "sessionId": "...",
      "sessionFile": "...",
      "cwd": "...",
      "createdAt": "...",
      "updatedAt": "..."
    },
    "omniroute/cc/*": { ... }
  }
}
```

- One timer **per scope entry** (Map<scopeGlob, Timeout>).
- Dedupe now **per scope** (earliest wakeAt wins within same scope).
- Migration: read v1 single-object → wrap into `entries[scopeGlob || "*"]` → write v2.

### Wake fire behavior

- Each scope fires its own resume message.
- Resume message names the scope: "scope `omniroute/cx/*` limit reset, resume".

---

## Command: /rate-limit-wakeup-set

```txt
/rate-limit-wakeup-set <time> [scope]

<time>   required. auto-detect:
           1. try absolute datetime (host tz if none)
           2. else relative duration (now + dur)
[scope]  optional. default = current model scope (computeScopeGlob(ctx.model))
           accepts raw glob: omniroute/cx/*
```

### Time parsing (V1 = relative duration ONLY, dependency-free)

```txt
supported:
  d / h / m / s tokens, spaces optional, combinable
    30s
    90m
    1h
    1h30m
    1h 29m 27s
    2d
    1d6h
    2d3h15m

rejected (V1):
  "90"      no unit  → error (ambiguous)
  "1530"    no unit  → error
  "15:30"   absolute → error "absolute time not supported yet"
  ISO/date  absolute → error "absolute time not supported yet"

wake = now + parsedDuration
no forced +buffer for manual set (user picked the time)
```

Parser: extend existing `parseDurationMs` to also match `d` (days = *86_400_000). Keep h/m/s as-is. All matching stays additive (2d3h = 2 days + 3 hours).

### Absolute datetime (DEFERRED, not V1)

When added later: try native `Date` for ISO + `YYYY-MM-DD HH:mm` + `HH:mm`, host tz. dayjs `customParseFormat` only if looser formats (`Jul 10 15:30`, locale dates) are wanted. Out of scope for V1.

---

## Footer change (wall-clock)

Now:

```txt
⏰ rate limit wake 1h 29m
```

New:

```txt
⏰ rate limit wake 15:30 (in 1h 29m)
```

- Wall-clock in host tz, `HH:mm` (or `HH:mm:ss` if < 1min).
- If multiple scopes pending → footer shows **soonest**:

```txt
⏰ rate limit wake 15:30 (in 1h 29m) +2 more
```

---

## TUI panel (rate-limit door)

Trigger options (pick in FASE 1):

```txt
1. /rate-limit           → open overlay panel
2. shortcut (e.g. ctrl+?) → open overlay panel
3. both
```

Panel content (overlay via ctx.ui.custom):

```txt
┌─ rate limit scopes ────────────────────────────┐
│ scope              wake       remaining  source │
│ omniroute/cx/*     15:30      1h 29m     429    │
│ omniroute/cc/*     16:10      2h 09m     manual │
│ anthropic/*        —          fired      429    │
├────────────────────────────────────────────────┤
│ [enter] resume now  [d] delete  [esc] close     │
└────────────────────────────────────────────────┘
```

- **V1 = read-only** (list only). Actions (resume/delete) = phase 2.
- Opened via **`/rate-limit` command only** (no shortcut V1).
- Uses `overlayOptions` (anchor, width) + `esc` to close.
- Empty state: "no pending rate-limit scopes".

---

## RESOLVED (all locked)

1. **dayjs vs dependency-free** → **dependency-free** (V1). Reuse/extend `parseDurationMs`.
2. **Multi-scope rewrite** → **YES, state v2 now** (Map keyed by scopeGlob, one timer per scope, migrate v1→v2).
3. **TUI trigger** → **`/rate-limit` command only** (no shortcut in V1).
4. **TUI actions** → **read-only V1** (list scopes; resume-now/delete deferred to phase 2).
5. **Manual buffer** → **no +60s buffer** for manual set.
6. **`[scope]` default** → current model scope via `computeScopeGlob(ctx.model)`; accepts raw glob (`omniroute/cx/*`) as-is.

---

## Implementation environment (historical, pre-package-extraction)

> **Provenance note:** the section below describes where this extension used
> to live *before* it was extracted into the standalone `pi-sheepdog`
> package. It no longer applies to this repo — kept for historical context
> only. The current source of truth is this repository
> (`tigorlazuardi/pi-sheepdog`, `extensions/sheepdog.ts`); there is no
> chezmoi round-trip anymore.

The extension originally had TWO locations, synced via chezmoi:

```txt
EDIT (old source of truth, chezmoi-managed dotfiles repo):
  /home/homeserver/.local/share/chezmoi/dot_pi/private_agent/extensions/rate-limit-wakeup.ts

DEPLOY to runtime (to load in pi):
  chezmoi apply
  -> writes /home/homeserver/.pi/agent/extensions/rate-limit-wakeup.ts

GIT (old flow):
  cd /home/homeserver/.local/share/chezmoi
  git add dot_pi/private_agent/extensions/rate-limit-wakeup.ts
  git commit -m "..."
```

### Per-task test strategy (historical)

```txt
per task (fast, on source):
  1. tsc --noEmit against installed pi types (temp tsconfig, as done before)
  2. node smoke: import default export = function; unit-test pure helpers
     (parseDurationMs w/ d, computeScopeGlob, time parser, migration v1->v2)

final integration task (last checklist item):
  chezmoi apply + verify runtime==source (sha256)
  manual note: user reloads pi to load new commands/TUI
```

## Orchestration recommendation

This is now **L-ish** (state v2 migration + command + footer + TUI overlay), not a trivial one-shot.

- Recommend: **ralph loop** (minor feature, long implementation, hat roles) OR a tight **one-shot with worker + frontier review** if we cut TUI to phase 2.
- Fault tolerance: **standard** (no auth/money/schema). Local disk state only.
- Vertical: **claude** (locked). Builder → `claude-worker` / `claude-frontier-worker`; Reviewer → `claude-reviewer` / `claude-frontier-reviewer`. This is standard-tolerance work (local disk state), so default tier = `claude-worker` + `claude-reviewer`.

Decision gate: user picks orchestration level before FASE 2.
