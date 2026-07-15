# Ticket 4 frontier spec fix

- Fixed valid RFC Retry-After HTTP-date handling for anthropic and openai-compatible adapters.
- Surfaced stop-generic reason through safe UI warning without raw headers.
- Added detection self-check coverage for both behaviors.
- Verification: `npm run self-check -- detection && rtk npm run check` PASS.
