# pi-sheepdog

A [pi](https://pi.dev) coding agent extension that watches for provider
rate-limit/quota errors (429s, "reset after ..." error text, or a time you
set by hand) and schedules a follow-up message that resumes your interrupted
task once the cooldown has passed — so you don't have to babysit the clock.

## What it does

Two automatic detection paths feed one scheduler:

- **`after_provider_response`** — inspects every provider HTTP response as it
  arrives. On a 429 it reads the wake time straight from known rate-limit
  headers (`retry-after`, `x-ratelimit-reset`, etc). Primary, most reliable
  path.
- **`agent_end`** — fallback for providers/transports that don't expose
  headers. Parses "reset after ...", "retry in ...", etc. out of the error
  text.

A third, manual path lets you set a timer yourself when you already know the
reset time (e.g. from a provider dashboard).

State is a global JSON file under `~/.pi/agent/.cache/rate-limit-wakeup/state.json`,
so pending wakes survive `/reload` and full process restarts. Each detection
is tagged with a scope derived from the model in play (e.g.
`anthropic/claude-sonnet-5` → `anthropic/*`), so rate limits on different
providers/model families are tracked and fired independently.

## Install

```bash
pi install git:github.com/tigorlazuardi/pi-sheepdog
```

Or clone manually and add the path to `~/.pi/agent/settings.json` under
`"packages"` — see [pi's package docs](https://pi.dev/docs/latest/packages)
for details.

## Commands

- `/rate-limit-wakeup` — list pending wakeup timers, if any.
- `/rate-limit-wakeup-set <duration> [scope]` — manually schedule a wakeup,
  e.g. `/rate-limit-wakeup-set 1h30m` or `/rate-limit-wakeup-set 2d3h anthropic/*`.
  Duration is relative only (`d`/`h`/`m`/`s` tokens); absolute time is not
  supported yet.
- `/rate-limit-wakeup-clear [scope]` — cancel pending wakeup timer(s), all
  scopes if none given.
- `/rate-limit` — read-only TUI panel listing every tracked scope (falls
  back to a plain notify list outside TUI mode).

Command names are kept identical to the original `rate-limit-wakeup`
extension this package was extracted from, so existing muscle memory and any
scripted `/rate-limit-wakeup-set` calls keep working unchanged.

## State

`~/.pi/agent/.cache/rate-limit-wakeup/state.json` (global, not per-project or
per-session — a rate limit is a provider/account-level condition). One entry
per scope glob, each with its own timer. If multiple pi processes hit a rate
limit for the *same* scope concurrently, whichever writes state last wins —
documented caveat, not a bug.

## Caveats

- Manual `/rate-limit-wakeup-set` only accepts relative durations
  (`1h30m`, `2d3h`); absolute datetimes are a possible future addition.
- The `/rate-limit` overlay panel is read-only in this version — no
  resume-now/delete actions from the panel yet.
- Peer dependencies (`@earendil-works/pi-*`, `typebox`) are provided by the
  pi runtime; this package does not bundle them.

See [`docs/SPEC.md`](docs/SPEC.md) for the original design notes, and
[`HANDOVER.md`](HANDOVER.md) for provenance and repo-setup status.
