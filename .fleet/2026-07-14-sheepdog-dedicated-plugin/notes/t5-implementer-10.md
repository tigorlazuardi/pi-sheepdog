# Ticket 5 implementer — attempt 10

- Removed malformed duplicate rate-limit parser fragment and incomplete duplicate `computeModelRef` merge artifact.
- Extracted pure mapper parsing/resolution into TypeScript ESM `extensions/sheepdog-mapper.ts`; runtime and self-check now exercise same implementation.
- Runtime now surfaces each safe config warning via UI while retaining valid mapper rules. Adapter credential values remain absent from warnings.
- Preserved state v3 semantics: `originalSource` normalization remains restricted to manual entries; lock/read-merge-write and atomic rename unchanged.

Verification:
- `npm run self-check -- state` — pass (`self-check: state ok`).
- `npm run check` — pass (Astro 11 pages built; package dry-run produced `pi-sheepdog-0.1.0.tgz`). Existing non-fatal Pagefind `Entry docs → 404 was not found` and Node DEP0190 warning remained.
- `npm run self-check -- mapper` — pass (`self-check: mapper ok`).
- TypeScript strip syntax checks and `git diff --check` — pass.
