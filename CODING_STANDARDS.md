# Coding Standards — pi-sheepdog

These standards are part of the build contract. Reviewers must fail changes that violate them unless the spec explicitly changes first.

## Product boundary

- Sheepdog handles cooldown recovery only: provider cooldown/rate-limit signals, scoped wakes, safe panel CRUD, and local debug logs.
- Do not add general watchdog behavior, job monitoring, process supervision, or broad failure recovery.
- Do not monkeypatch global `fetch` or Pi internals to capture response bodies.

## Public surface

- Public identity is `sheepdog`.
- Only slash command forms are `/sheepdog` and `/sheepdog config`.
- Do not add command-based create/edit/delete for wakes. CRUD belongs in the panel.
- Human-facing times must be local friendly strings, never raw UTC ISO.
- State may store UTC ISO.

## Config and paths

- Agent dir resolution is exactly `PI_CODING_AGENT_DIR || ~/.pi/agent`.
- Config path: `${agentDir}/sheepdog/config.json`.
- State path: `${agentDir}/.cache/sheepdog/state.json`.
- Debug log path: `${agentDir}/sheepdog/debug.log`.
- Config is strict JSON, not JSONC. Generated config stays minimal.
- Mapper rules are first-match-wins.
- Mapper `args` are adapter-specific. Do not introduce a global untyped config bag.
- Invalid mapper rules or adapter args warn and skip only that rule.

## State and concurrency

- State writes must use short lock + temp file + rename.
- No jitter-only concurrency fixes.
- Same-scope automatic detections keep the earliest wake.
- Manual add/edit overrides same-scope auto wake and stays sticky until terminal.
- Startup-overdue pending wakes expire silently.

## Detection

- Detection should be small adapters/interceptors, not one large provider switch.
- v1 adapters: `generic`, `anthropic`, `openai-compatible`.
- Generic error-text fallback requires both:
  - rate-limit/quota/429/too-many-requests indicator
  - parseable cooldown duration
- Duration alone must not schedule a wake.
- Adapter may block generic fallback for known ambiguous provider signals.

## Wake delivery

- Agent follow-up requires current main model matching wake scope, or scope `*`.
- Mismatched due wake never sends agent follow-up.
- Mismatched due wake may send one short human UI notice per entry.
- Busy due wake waits until idle.
- No polling loop; recheck on Pi events and command/panel open.

## UI

- `/sheepdog` interactive panel is the only write UI for wakes.
- Panel must show all scopes with relevance markers.
- Add/edit fields: scope glob + relative duration; preview local wake time before save.
- Delete selected and clear all require confirmation.
- Non-TUI fallback is read-only.

## Logging and privacy

- Observability is local debug logs only. No external telemetry or OTel in v1.
- Redact secrets: auth headers, cookies, tokens, API keys, JWTs, passwords, private keys, credential contents, sensitive adapter args.
- Truncate provider/user excerpts.
- Never log full provider payloads or credential files.

## Code style

- TypeScript ESM.
- Prefer boring functions over classes unless stateful UI/runtime object needs one.
- Keep parsing functions pure where possible; pass clocks/filesystem as tiny dependencies for tests.
- No new runtime dependency unless it removes more code than it adds and is already needed by Pi extension conventions.
- Small helpers over broad abstractions. No interfaces with one implementation unless they are adapter contracts.
- Errors shown to users should include the bad rule/field and safe next action.

## Docs-site contract

- Human QA source of truth is the rendered docs site, not raw markdown meant for agents.
- Docs must be written for a human reading flow: overview → install → quickstart → configure → operate panel → blackbox QA scenarios → troubleshooting/reference.
- Every step in docs must be executable verbatim.
- If docs say a command, path, key, button, or expected output exists, implementation must match it exactly.
- Docs-site must build and be previewable locally before handoff.
- Raw README can exist, but the docs site is the primary QA contract.

## Checks required before handoff

- Unit self-check script for time formatting, mapper validation, adapter detection, redaction, state merge/lock behavior.
- Typecheck passes.
- `npm pack --dry-run` passes.
- Docs site builds and the human reading flow is complete.
- README and docs site match actual command/config behavior.
