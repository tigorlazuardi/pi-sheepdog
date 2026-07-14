# Ticket 5 completion report

## Result

- Shared state implementation is `extensions/sheepdog-state.ts`, a TypeScript ESM module.
- Extension runtime, self-check process, and spawned self-check workers import that module using its `.ts` path and run through Node's built-in type stripping.
- `originalSource` survives normalization only when an entry is manual. Legacy migration and automatic detection leave it unset.

## Verification

Passed:

```sh
npm run self-check -- state && npm run check
```

The state self-check passed concurrent different-scope locked writes, manual stickiness, earliest automatic wake selection, automatic/migrated `originalSource` omission, and manual override source preservation. `npm run check` built docs and completed `npm pack --dry-run`.

## Commit

`72b3e825a8046d5ef72eb33692a7bfbd36bd09fb` — `fix(sheepdog): keep automatic state source unset`
