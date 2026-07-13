# pi-sheepdog

pi-sheepdog is a standalone Pi extension package that watches interrupted agent work and schedules a later resume when provider limits clear.

## Language

**Sheepdog**:
The public product identity of this extension package. Use for package name, command namespace, docs, cache/state ownership, and user-facing status labels.
_Avoid_: rate-limit-wakeup, wakeup extension

**Wake**:
A scheduled follow-up message that resumes or prompts continuation after a provider cooldown has passed.
_Avoid_: retry, reminder, timer

**Clear Action**:
A panel-only action that cancels one pending wake or all pending wakes. It is intentionally not exposed as a slash command because typo-prone destructive command text is too risky.
_Avoid_: clear command, delete timer command

**Scope**:
A provider/model-family key that groups rate-limit state, such as `anthropic/*`, so unrelated provider limits do not overwrite each other.
_Avoid_: namespace, provider key

**Cooldown**:
The waiting period imposed by a provider before work can safely resume.
_Avoid_: reset window, delay

**Cooldown Recovery**:
Sheepdog's product boundary: best-effort recovery from provider-imposed cooldowns, focused on popular/provider-known patterns plus conservative rate-limit fallback detection.
_Avoid_: general watchdog, full agent failure recovery

**Main Model**:
The model currently selected in the active Pi session. A scoped wake is relevant to the main agent only when its scope matches this model.
_Avoid_: current model, active provider

**Catch-all Wake**:
A wake whose provider/model scope could not be determined. It is treated as globally relevant rather than tied to a specific model family.
_Avoid_: untagged timer, unknown scope

**Provider Adapter**:
A small parser strategy for a known cooldown response format. It converts provider-specific headers or text into a wake delay without making Sheepdog a full provider SDK matrix.
_Avoid_: provider SDK, integration plugin

**Cooldown Interceptor**:
An ordered detection step that inspects one provider signal source and returns no-match, matched cooldown, or a reason to stop generic fallback. Interceptors keep provider-specific quirks out of one giant parser.
_Avoid_: monolithic parser, provider SDK

**Regex Mapper**:
An ordered user-configurable rule that maps model references such as `<provider>/<model-group>/<model-name>` to a Provider Adapter, scope template, and optional adapter-specific `args`. First matching rule wins, so specific rules come before broad rules.
_Avoid_: custom parser, provider config

**Adapter Args**:
Optional per-mapper configuration passed only to the selected Provider Adapter, such as credential file path, credential directory, or base URL override. Args are adapter-owned: each adapter validates and redacts its own keys.
_Avoid_: global config bag, hardcoded env-only behavior

**Agent Directory**:
The Pi agent home used by Sheepdog for global config and state. It is `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.
_Avoid_: project config, PI_CONFIG_DIR
