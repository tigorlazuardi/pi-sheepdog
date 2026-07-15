# Ticket 4 implementer — attempt 2

- Narrow fix: adapter interceptor now blocks only comma-separated numeric `Retry-After` values, not RFC HTTP-dates containing commas.
- Added production-path detection check: Anthropic-selected adapter accepts future HTTP-date; `60, 120` remains `stop-generic`.
- Acceptance passed: `npm run self-check -- detection && npm run check`.
