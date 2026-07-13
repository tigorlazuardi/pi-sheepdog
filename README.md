# pi-sheepdog

Sheepdog is a Pi extension for **cooldown recovery**.

It watches for provider cooldown signals, tracks wake entries by scope, and resumes or notifies only when the cooldown has passed and the active model context is relevant.

## Install

```bash
pi install git:github.com/tigorlazuardi/pi-sheepdog
```

## Current command surface

- `/sheepdog`
- `/sheepdog config`

## Docs

Primary consumer docs and blackbox QA contract:

- GitHub Pages: `https://tigorlazuardi.github.io/pi-sheepdog/`
- Local preview/build: `cd docs && npm install && npm run build`

Internal implementation and provenance docs stay in the repo and are not the published contract:

- `plans/sheepdog-dedicated-plugin/SPEC.mdx`
- `plans/sheepdog-dedicated-plugin/TICKETS.mdx`
- `plans/legacy/SPEC.md`
- `CODING_STANDARDS.md`
- `CONTEXT.md`
