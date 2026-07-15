# Ticket 5 review fix

Resolved duplicated state self-check and production logic by moving shared state normalization, lock/atomic write, and auto-merge behavior into `extensions/sheepdog-state.js`. The extension and self-check now call that single implementation; existing state-v3 semantics remain covered by the required state self-check.

Verification: `npm run self-check -- state && npm run check` passed.
