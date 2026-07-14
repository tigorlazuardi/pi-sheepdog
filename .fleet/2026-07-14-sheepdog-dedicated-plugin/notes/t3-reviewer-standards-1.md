# Standards review — t3 attempt 1

Verdict: ESCALATE

Low-tolerance surface: this diff adds mapper adapter args for credential/config paths and persists them into runtime state, so it touches secrets/credentials handling.

Findings:

- `extensions/sheepdog.ts:1029` — `adapterArgs: mapper.args` writes adapter-specific args into `state.json`. The repo privacy standard requires redacting secrets, credential contents, and sensitive adapter args; the new Anthropic args include `credentialFile` and `configDir`, and the persisted state has no redaction boundary. The value is also not used by wake scheduling/delivery in this diff. Fix by deleting `adapterArgs` from `WakeEntry` and from the persisted entry, or persist only an explicit redacted/safe subset if a later adapter genuinely needs it.
