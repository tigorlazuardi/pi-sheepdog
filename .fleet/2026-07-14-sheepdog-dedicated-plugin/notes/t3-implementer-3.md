# Ticket 3 implementer notes

- Prior handover pointer was missing, so resumed from ticket spec and fixed point.
- Added strict `{ "mappers": [] }` config creation/validation for `/sheepdog config`.
- Added ordered mapper resolution for adapter id, scope, and adapter-specific args; invalid regex/adapter/args warn and skip only that rule.
- Added Anthropic args (`credentialFile`, `configDir`, `baseUrl`) with `$HOME`/`~` expansion only for path args.
- Detection upsert now records selected adapter/args and uses first matching mapper scope before generic fallback.
- Added mapper self-check coverage for invalid-rule skipping, unknown adapter, invalid args, first-match wins, and path expansion.

Checks:
- `npm --prefix /home/homeserver/projects/pi-sheepdog/.fleet/2026-07-14-sheepdog-dedicated-plugin/worktrees/task-d1-t3 run self-check -- mapper && npm --prefix /home/homeserver/projects/pi-sheepdog/.fleet/2026-07-14-sheepdog-dedicated-plugin/worktrees/task-d1-t3 run check` passed.
