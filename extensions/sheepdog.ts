// pi-sheepdog: detects provider rate-limit/quota conditions and schedules
// a follow-up message that resumes the interrupted task once the cooldown
// has passed. Two independent detection paths feed the same scheduler:
//
//   - after_provider_response: fires for every provider HTTP response,
//     before the stream body is consumed. On a 429 we parse the wake time
//     directly from known rate-limit response headers (retry-after,
//     x-ratelimit-reset, etc). This is the primary, most reliable path.
//   - agent_end: fallback for providers/transports that don't expose
//     headers (or errors surfaced only as text). Parses "reset after ..."
//     style phrasing out of the error message.
//
// State is persisted to a global JSON file under the Pi agent dir's cache
// so pending wakes survive /reload and full process restarts: session_start
// re-reads the file, reschedules every remaining entry, or fires it
// immediately if its wake time already passed while pi was not running.
//
// This extension is intentionally not session-scoped (the state file is
// global, not per-project or per-session) because a rate limit is a
// provider/account-level condition, not a per-session one. If multiple pi
// processes hit rate limits concurrently for *different* scopes, each gets
// its own tracked entry (see "state v2" below); for the *same* scope,
// whichever process wrote last wins — documented caveat, not a bug.
//
// --- state v2: multi-scope -------------------------------------------------
//
// Each detection is tagged with a dynamic
// `scopeGlob` derived from the model in play at detection time (see
// computeModelRef / computeScopeGlob below): `omniroute/cx/gpt-5.4` ->
// `omniroute/cx/*`, `anthropic/claude-sonnet-5` -> `anthropic/*`. There is no
// hardcoded model/provider allow-list anywhere in this file.
//
// state.json holds one entry PER SCOPE (entries[scopeGlob]), each with its
// own in-process setTimeout, so a rate limit on `omniroute/cx/*` and a
// separate rate limit on `anthropic/*` are tracked independently and each
// fires its own resume message naming the scope it belongs to. Detections
// with no resolvable model (scopeGlob undefined) are filed under the
// catch-all key "*" (see CATCHALL_SCOPE below).
//
// Dedupe is per-scope: for a given scope, the earliest wakeAt among pending
// detections wins (see upsertDetectedState).
//
// state.json v1 (pre-multi-scope: a single global wakeAt, no `entries` map)
// is migrated in place the first time it's read after upgrading: it gets
// wrapped into `entries[scopeGlob ?? "*"]` and rewritten as v2 so no pending
// wake is lost across the upgrade. See loadState() / migrateLegacyEntry().

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STATE_VERSION = 2;
const STATUS_KEY = "sheepdog";
const LEGACY_STATUS_KEY = "rate-limit-wakeup";

function resolveAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function getStateDir(): string {
  return path.join(resolveAgentDir(), ".cache", "sheepdog");
}

function getStatePath(): string {
  return path.join(getStateDir(), "state.json");
}

function getSheepdogDir(): string {
  return path.join(resolveAgentDir(), "sheepdog");
}

function getConfigPath(): string {
  return path.join(getSheepdogDir(), "config.json");
}

// Scope key used for entries with no resolvable model (no ctx.model, or a
// modelRef that couldn't be turned into a glob). Documented catch-all: any
// detection without a scope is filed here rather than fabricating one.
const CATCHALL_SCOPE = "*";

// Safety buffer added on top of the parsed reset duration so we don't wake
// up a few seconds before the provider actually lifts the limit.
const SAFETY_BUFFER_MS = 60_000;

// Node's setTimeout silently overflows for delays beyond ~24.8 days
// (2^31-1 ms). For that unlikely case we schedule an intermediate wake and
// recompute the remaining delay when it fires, rather than firing early.
const MAX_TIMEOUT_MS = 2_147_483_000;

type WakeStatus = "pending" | "fired" | "cancelled";
type AdapterId = "generic" | "anthropic" | "openai-compatible";
type AdapterArgs = Record<string, string>;

interface MapperRule {
  regex: RegExp;
  adapter: AdapterId;
  scope: string;
  args: AdapterArgs;
}

interface LoadedConfig {
  rules: MapperRule[];
  warnings: string[];
  created: boolean;
}

interface Component {
  readonly width?: number;
  wantsKeyRelease?: boolean;
  handleInput?(data: string): void;
  invalidate(): void;
  render(width: number): string[];
}

function matchesKey(data: string, keyId: "escape" | "return"): boolean {
  if (keyId === "escape") return data === "\u001b";
  if (keyId === "return") return data === "\r" || data === "\n";
  return false;
}

function visibleWidth(str: string): number {
  return [...str.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")].length;
}

// Which of the three paths produced this entry. "provider-429" = parsed
// from a 429 response's headers; "agent_end" = parsed from error text;
type RateLimitSource = "provider-429" | "agent_end";

interface WakeEntry {
  // Always equal to the key this entry is stored under in
  // StateFileV2.entries — duplicated onto the entry itself so callers that
  // only have the entry (e.g. inside a setTimeout closure) don't need to
  // thread the key through separately.
  scopeGlob: string;
  status: WakeStatus;
  wakeAt: string; // ISO timestamp
  delayMs: number; // total delay from detection to wakeAt (including buffer, if any)
  sourceExcerpt: string; // trimmed excerpt of the error text that triggered this
  source: RateLimitSource;
  adapter?: AdapterId;
  modelRef?: string; // e.g. "omniroute/cx/gpt-5.4", model detected on (if any)
  sessionId?: string;
  sessionFile?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

interface StateFileV2 {
  version: 2;
  entries: Record<string, WakeEntry>;
}

// --- rate limit / duration parsing -----------------------------------------

const RATE_LIMIT_INDICATOR = /rate.?limit|quota|429|too many requests/i;

// Looks for "reset after ...", "retry after ...", "resets in ...", "retry in ...",
// "try again in ..." followed by a d/h/m/s duration, case-insensitive.
const DURATION_KEYWORD = /(?:reset|resets|retry)\s+(?:after|in)\s+|try\s+again\s+in\s+/i;

// Trailing \b would fail between two word characters (e.g. the "d"/"3"
// boundary inside "2d3h"), silently dropping units whenever a compact
// multi-unit duration appears with no separators. Use a negative lookahead
// that only rejects a following letter (so an adjacent digit, which starts
// the next unit token, is still allowed) instead.
const DAYS_RE = /(\d+)\s*d(?:ays?)?(?![a-z])/i;
const HOURS_RE = /(\d+)\s*h(?:ours?|rs?)?(?![a-z])/i;
const MINUTES_RE = /(\d+)\s*m(?:in(?:ute)?s?)?(?![a-z])/i;
const SECONDS_RE = /(\d+)\s*s(?:ec(?:ond)?s?)?(?![a-z])/i;

// Window of text scanned for d/h/m/s tokens after the duration keyword. Real
// messages are short, so this stays well clear of unrelated numbers further
// along in the string.
const DURATION_WINDOW = 60;

interface ParsedRateLimit {
  delayMs: number;
  excerpt: string;
}

// Scans freeform text for d/h/m/s tokens and sums them additively (e.g.
// "2d3h" -> 2 days + 3 hours). Used for both the agent_end text parser and
// the provider-header freeform fallback. This is intentionally lenient
// (matches tokens anywhere in the window, ignores anything else) — the
// strict, whole-string variant for /rate-limit-wakeup-set is
// parseRelativeDurationStrict() below.
function parseDurationMs(window: string): number | null {
  let totalMs = 0;
  let matched = false;

  const days = window.match(DAYS_RE);
  if (days) {
    totalMs += Number.parseInt(days[1], 10) * 86_400_000;
    matched = true;
  }
  const hours = window.match(HOURS_RE);
  if (hours) {
    totalMs += Number.parseInt(hours[1], 10) * 3_600_000;
    matched = true;
  }
  const minutes = window.match(MINUTES_RE);
  if (minutes) {
    totalMs += Number.parseInt(minutes[1], 10) * 60_000;
    matched = true;
  }
  const seconds = window.match(SECONDS_RE);
  if (seconds) {
    totalMs += Number.parseInt(seconds[1], 10) * 1_000;
    matched = true;
  }

  if (!matched || totalMs <= 0) {
    return null;
  }
  return totalMs;
}

/**
 * Detects a rate-limit/quota error and extracts a reset duration.
 * Returns null when the text doesn't look like a rate limit error, or a
 * rate limit is mentioned but no parseable duration is present.
 */
function parseRateLimitError(errorMessage: string): ParsedRateLimit | null {
  if (!errorMessage || !RATE_LIMIT_INDICATOR.test(errorMessage)) {
    return null;
  }

  const keywordMatch = errorMessage.match(DURATION_KEYWORD);
  if (!keywordMatch || keywordMatch.index === undefined) {
    return null;
  }

  const windowStart = keywordMatch.index + keywordMatch[0].length;
  const window = errorMessage.slice(windowStart, windowStart + DURATION_WINDOW);
  const durationMs = parseDurationMs(window);
  if (durationMs === null) {
    return null;
  }

  return {
    delayMs: durationMs + SAFETY_BUFFER_MS,
    excerpt: errorMessage.slice(0, 400),
  };
}

// --- provider response (429) header parsing --------------------------------

// Known rate-limit response headers, in priority order (most precise/direct
// first). Only these are ever read or included in the persisted excerpt —
// we deliberately never dump the full header set, to avoid leaking cookies,
// auth, or other sensitive response headers into on-disk state.
const RATE_LIMIT_HEADER_NAMES = [
  "retry-after-ms",
  "x-retry-after-ms",
  "retry-after",
  "x-ratelimit-reset-after",
  "x-rate-limit-reset-after",
  "reset-after",
  "x-ratelimit-reset",
  "x-rate-limit-reset",
];

const NUMERIC_RE = /^\d+(?:\.\d+)?$/;

const ADAPTER_IDS = new Set<AdapterId>(["generic", "anthropic", "openai-compatible"]);
const ANTHROPIC_ARG_NAMES = new Set(["credentialFile", "configDir", "baseUrl"]);
const PATH_ARG_NAMES = new Set(["credentialFile", "configDir"]);
const MINIMAL_CONFIG = '{\n  "mappers": []\n}\n';

function getHeaderCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const value = headers[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

// Parses a duration out of freeform header text, reusing the same d/h/m/s
// scanning logic as the agent_end message parser. Tries the "reset after"
// style keyword window first (in case a provider echoes message-like text
// into a header), then falls back to scanning the raw value directly since
// header values are short and rarely contain unrelated numbers.
function parseFreeformDurationMs(text: string): number | null {
  const keywordMatch = text.match(DURATION_KEYWORD);
  if (keywordMatch && keywordMatch.index !== undefined) {
    const windowStart = keywordMatch.index + keywordMatch[0].length;
    const window = text.slice(windowStart, windowStart + DURATION_WINDOW);
    const fromKeyword = parseDurationMs(window);
    if (fromKeyword !== null) {
      return fromKeyword;
    }
  }
  return parseDurationMs(text.slice(0, DURATION_WINDOW));
}

// Parses a single rate-limit header's value into a millisecond delay from
// now. Interpretation depends on both the header name (which unit/format a
// header conventionally uses) and the value's shape (numeric vs date vs
// freeform text), since providers are inconsistent here.
function parseHeaderDelayMs(headerName: string, rawValue: string): number | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }
  const lowerName = headerName.toLowerCase();

  if (NUMERIC_RE.test(value)) {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n) || n < 0) {
      return null;
    }

    if (lowerName.includes("-ms")) {
      // retry-after-ms / x-retry-after-ms: already a millisecond delta.
      return n;
    }
    if (lowerName === "retry-after") {
      // RFC 7231: retry-after numeric value is a seconds delta.
      return n * 1_000;
    }
    if (lowerName.includes("reset-after")) {
      // x-ratelimit-reset-after / x-rate-limit-reset-after / reset-after:
      // seconds delta by convention (GitHub, Discord, etc).
      return n * 1_000;
    }
    if (lowerName.includes("reset")) {
      // x-ratelimit-reset / x-rate-limit-reset: absolute reset timestamp,
      // as unix seconds or unix milliseconds depending on magnitude. A
      // small value (below the unix-seconds range) is ambiguous but most
      // commonly means "seconds until reset", so treat it as a delta.
      const nowMs = Date.now();
      if (n >= 1e12) {
        return n - nowMs;
      }
      if (n >= 1e9) {
        return n * 1_000 - nowMs;
      }
      return n * 1_000;
    }
    // Unrecognized numeric convention: default to seconds delta.
    return n * 1_000;
  }

  const parsedDate = Date.parse(value);
  if (!Number.isNaN(parsedDate)) {
    return parsedDate - Date.now();
  }

  return parseFreeformDurationMs(value);
}

/**
 * Parses a wake delay directly out of a 429 provider response's headers.
 * Checks known rate-limit headers in priority order and returns the first
 * one that yields a usable positive delay. Returns null when no known
 * rate-limit header is present or none parse to a usable delay.
 */
function parseProviderRateLimit(headers: Record<string, string> | undefined | null): ParsedRateLimit | null {
  if (!headers || typeof headers !== "object") {
    return null;
  }

  const present: Array<[string, string]> = [];
  for (const name of RATE_LIMIT_HEADER_NAMES) {
    const value = getHeaderCaseInsensitive(headers, name);
    if (value !== undefined) {
      present.push([name, value]);
    }
  }
  if (present.length === 0) {
    return null;
  }

  let delayMs: number | null = null;
  for (const [name, value] of present) {
    const parsed = parseHeaderDelayMs(name, value);
    if (parsed !== null && Number.isFinite(parsed) && parsed > 0) {
      delayMs = parsed;
      break;
    }
  }
  if (delayMs === null) {
    return null;
  }

  // Only known rate-limit headers are ever included here, never the full
  // header set (see RATE_LIMIT_HEADER_NAMES comment above).
  const excerpt = `provider response 429; ${present.map(([name, value]) => `${name}=${value}`).join("; ")}`;

  return {
    delayMs: delayMs + SAFETY_BUFFER_MS,
    excerpt: excerpt.slice(0, 400),
  };
}

// --- config / mapper ---------------------------------------------------------

function expandPathValue(value: string): string {
  if (value === "$HOME") return os.homedir();
  if (value.startsWith("$HOME/")) return path.join(os.homedir(), value.slice(6));
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function validateAdapterArgs(adapter: AdapterId, rawArgs: unknown, ruleLabel: string): { args: AdapterArgs; warning?: string } {
  if (rawArgs === undefined) return { args: {} };
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { args: {}, warning: `${ruleLabel}: args must be an object` };
  }

  const args: AdapterArgs = {};
  for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
    if (adapter !== "anthropic" || !ANTHROPIC_ARG_NAMES.has(key)) {
      return { args: {}, warning: `${ruleLabel}: unknown args.${key} for adapter ${adapter}` };
    }
    if (typeof value !== "string" || value.length === 0) {
      return { args: {}, warning: `${ruleLabel}: args.${key} must be a non-empty string` };
    }
    args[key] = PATH_ARG_NAMES.has(key) ? expandPathValue(value) : value;
  }
  return { args };
}

function createConfigIfMissing(): boolean {
  if (fs.existsSync(getConfigPath())) return false;
  fs.mkdirSync(getSheepdogDir(), { recursive: true });
  fs.writeFileSync(getConfigPath(), MINIMAL_CONFIG, "utf8");
  return true;
}

function loadConfig(createMissing = false): LoadedConfig {
  const warnings: string[] = [];
  let created = false;
  try {
    if (!fs.existsSync(getConfigPath())) {
      if (createMissing) created = createConfigIfMissing();
      return { rules: [], warnings, created };
    }

    const parsed = JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { rules: [], warnings: ["config root must be an object"], created };
    }
    const mappers = (parsed as Record<string, unknown>).mappers;
    if (!Array.isArray(mappers)) {
      return { rules: [], warnings: ["config.mappers must be an array"], created };
    }

    const rules: MapperRule[] = [];
    mappers.forEach((raw, index) => {
      const label = `mappers[${index}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        warnings.push(`${label}: rule must be an object`);
        return;
      }
      const rule = raw as Record<string, unknown>;
      if (typeof rule.match !== "string" || typeof rule.scope !== "string" || typeof rule.adapter !== "string") {
        warnings.push(`${label}: match, adapter, and scope must be strings`);
        return;
      }
      if (!ADAPTER_IDS.has(rule.adapter as AdapterId)) {
        warnings.push(`${label}: unknown adapter ${rule.adapter}`);
        return;
      }
      let regex: RegExp;
      try {
        regex = new RegExp(rule.match);
      } catch (error) {
        warnings.push(`${label}: invalid regex ${rule.match} (${error instanceof Error ? error.message : "error"})`);
        return;
      }
      const adapter = rule.adapter as AdapterId;
      const { args, warning } = validateAdapterArgs(adapter, rule.args, label);
      if (warning) {
        warnings.push(warning);
        return;
      }
      rules.push({ regex, adapter, scope: rule.scope, args });
    });
    return { rules, warnings, created };
  } catch (error) {
    return { rules: [], warnings: [`config unreadable: ${error instanceof Error ? error.message : "error"}`], created };
  }
}

function resolveMapper(modelRef: string | undefined, config = loadConfig()): { adapter: AdapterId; scopeGlob: string; args: AdapterArgs } {
  if (modelRef) {
    for (const rule of config.rules) {
      if (rule.regex.test(modelRef)) {
        return { adapter: rule.adapter, scopeGlob: rule.scope, args: rule.args };
      }
    }
  }
  return { adapter: "generic", scopeGlob: computeScopeGlob(modelRef) ?? CATCHALL_SCOPE, args: {} };
}

// --- dynamic rate-limit scope ------------------------------------------------

// Builds a "provider/id" model reference from the session's current model.
// Deliberately reads ctx.model live at detection time rather than caching it
// anywhere — there is no hardcoded model or provider name in this file.
// Returns undefined when no model is selected, or when either half is empty
// (should not normally happen, but we never want to fabricate a ref).
function computeModelRef(ctx: ExtensionContext): string | undefined {
  try {
    const model = ctx.model;
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
      return undefined;
    }
    if (model.provider.length === 0 || model.id.length === 0) {
      return undefined;
    }
    return `${model.provider}/${model.id}`;
  } catch {
    return undefined;
  }
}

// Derives a rate-limit scope glob from a model ref by replacing only the
// final "/"-delimited segment with "*". This generalizes just far enough to
// cover "same model family, different specific model id" rate limits without
// guessing at provider-specific grouping rules:
//   omniroute/cx/gpt-5.4        -> omniroute/cx/*
//   openrouter/openai/gpt-5.4   -> openrouter/openai/*
//   anthropic/claude-sonnet-5   -> anthropic/*
// Safest-behavior choice for the missing-slash case: a modelRef we build
// ourselves is always "provider/id" (see computeModelRef above) so it should
// always contain at least one "/". If it somehow doesn't, we treat the ref
// as opaque and return undefined rather than fabricating a scope like
// "unknown/*" that could accidentally overlap with a real provider named
// "unknown" — callers fall back to CATCHALL_SCOPE when this returns
// undefined.
function computeScopeGlob(modelRef: string | undefined): string | undefined {
  if (!modelRef) {
    return undefined;
  }
  const lastSlash = modelRef.lastIndexOf("/");
  if (lastSlash === -1) {
    return undefined;
  }
  return `${modelRef.slice(0, lastSlash)}/*`;
}

// --- state (v2, multi-scope) -------------------------------------------------

// Best-effort shape check for a v1 (single global wake) state file, so we
// can migrate it without importing the old, no-longer-defined WakeState
// type. Anything not matching this (or the current v2 shape) is treated as
// corrupt/unreadable, same as before.
function looksLikeLegacyV1(parsed: unknown): parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const p = parsed as Record<string, unknown>;
  return p.version === 1 && typeof p.wakeAt === "string";
}

function looksLikeV2(parsed: unknown): parsed is StateFileV2 {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  const p = parsed as Record<string, unknown>;
  return p.version === STATE_VERSION && !!p.entries && typeof p.entries === "object";
}

// Wraps a v1 legacy state object into a v2 WakeEntry. The source field
// didn't exist in v1 — both the header-429 and agent_end paths wrote into
// the same untagged WakeState — so we recover it heuristically from the
// excerpt's format (only the header path ever wrote the
// "provider response 429; ..." prefix, see parseProviderRateLimit above).
function migrateLegacyEntry(legacy: Record<string, unknown>, scopeKey: string): WakeEntry {
  const excerpt = typeof legacy.sourceExcerpt === "string" ? legacy.sourceExcerpt : "";
  const source: RateLimitSource = excerpt.startsWith("provider response 429;") ? "provider-429" : "agent_end";
  const status: WakeStatus =
    legacy.status === "pending" || legacy.status === "fired" || legacy.status === "cancelled"
      ? legacy.status
      : "cancelled";
  const now = new Date().toISOString();
  return {
    scopeGlob: scopeKey,
    status,
    wakeAt: typeof legacy.wakeAt === "string" ? legacy.wakeAt : now,
    delayMs: typeof legacy.delayMs === "number" ? legacy.delayMs : 0,
    sourceExcerpt: excerpt,
    source,
    adapter: "generic",
    modelRef: typeof legacy.modelRef === "string" ? legacy.modelRef : undefined,
    sessionId: typeof legacy.sessionId === "string" ? legacy.sessionId : undefined,
    sessionFile: typeof legacy.sessionFile === "string" ? legacy.sessionFile : undefined,
    cwd: typeof legacy.cwd === "string" ? legacy.cwd : process.cwd(),
    createdAt: typeof legacy.createdAt === "string" ? legacy.createdAt : now,
    updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : now,
  };
}

// Loads state.json, migrating a pre-multi-scope v1 file in place (and
// persisting the migration immediately) so a pending v1 wake is never lost
// across the upgrade. Returns null when the file doesn't exist or is
// unreadable/corrupt.
function loadState(): StateFileV2 | null {
  try {
    const raw = fs.readFileSync(getStatePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (looksLikeV2(parsed)) {
      return parsed;
    }

    if (looksLikeLegacyV1(parsed)) {
      const legacy = parsed as Record<string, unknown>;
      const scopeKey =
        typeof legacy.scopeGlob === "string" && legacy.scopeGlob.length > 0 ? legacy.scopeGlob : CATCHALL_SCOPE;
      const migrated: StateFileV2 = {
        version: STATE_VERSION,
        entries: { [scopeKey]: migrateLegacyEntry(legacy, scopeKey) },
      };
      saveState(migrated);
      return migrated;
    }

    return null;
  } catch {
    return null;
  }
}

function saveState(state: StateFileV2): void {
  try {
    fs.mkdirSync(getStateDir(), { recursive: true });
    withStateLock(() => {
      const statePath = getStatePath();
      const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tempPath, statePath);
    });
  } catch {
    // fail open: an unpersisted timer still fires for this process's lifetime.
  }
}

function withStateLock<T>(fn: () => T): T {
  const lockPath = `${getStatePath()}.lock`;
  const deadline = Date.now() + 1_000;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        fs.rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST" || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function pendingEntries(state: StateFileV2 | null): WakeEntry[] {
  if (!state) {
    return [];
  }
  return Object.values(state.entries).filter((entry) => entry.status === "pending");
}

function safeSessionId(ctx: ExtensionContext): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function safeSessionFile(ctx: ExtensionContext): string | undefined {
  try {
    const file = ctx.sessionManager?.getSessionFile?.();
    return typeof file === "string" && file.length > 0 ? file : undefined;
  } catch {
    return undefined;
  }
}

// --- formatting ---------------------------------------------------------------

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const h = Math.floor((totalSeconds % 86_400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || h > 0) parts.push(`${h}h`);
  if (days === 0 && (h > 0 || m > 0)) parts.push(`${m}m`);
  if (days === 0 && h === 0) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}

const LOCAL_WAKE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const LOCAL_WAKE_WEEKDAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
});

const LOCAL_WAKE_MONTH_DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const LOCAL_WAKE_MONTH_DAY_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function localDayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function diffLocalDays(left: Date, right: Date): number {
  return Math.round((localDayStart(left) - localDayStart(right)) / 86_400_000);
}

function formatLocalWakeTime(date: Date, now = new Date()): string {
  const dayDiff = diffLocalDays(date, now);
  const time = LOCAL_WAKE_TIME_FORMAT.format(date);

  if (dayDiff === 0) {
    return `today ${time}`;
  }
  if (dayDiff === 1) {
    return `tomorrow ${time}`;
  }
  if (dayDiff > 1 && dayDiff < 7) {
    return `${LOCAL_WAKE_WEEKDAY_FORMAT.format(date)} ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${LOCAL_WAKE_MONTH_DAY_FORMAT.format(date)} ${time}`;
  }
  return `${LOCAL_WAKE_MONTH_DAY_YEAR_FORMAT.format(date)} ${time}`;
}

// Wall-clock wake time in the host machine's local timezone. HH:mm normally,
// HH:mm:ss when under a minute remains (matches the spec's footer format).
function formatWallClock(iso: string, remainingMs: number): string {
  const d = new Date(iso);
  if (remainingMs >= 60_000) {
    return formatLocalWakeTime(d);
  }
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// --- /sheepdog panel (read-only, v1) -----------------------------------------

// Read-only overlay listing every tracked scope. No actions in V1 (see spec:
// resume-now/delete are phase 2) — the only input handled is Escape to
// close. Column layout: scope | wake | remaining | source.
class RateLimitPanel implements Component {
  readonly width = 72;
  wantsKeyRelease = false;

  constructor(
    private theme: Theme,
    private entries: WakeEntry[],
    private done: (result: undefined) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.done(undefined);
    }
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const w = this.width;
    const th = this.theme;
    const innerW = w - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");
    const truncate = (s: string, max: number) => (visibleWidth(s) > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);

    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    lines.push(row(` ${th.fg("accent", "🐑 sheepdog scopes")}`));
    lines.push(row(""));

    if (this.entries.length === 0) {
      lines.push(row(` ${th.fg("dim", "no pending sheepdog scopes")}`));
    } else {
      const scopeW = 18;
      const wakeW = 18;
      const remW = 11;
      const header =
        ` ${pad(th.fg("dim", "scope"), scopeW)} ${pad(th.fg("dim", "wake"), wakeW)} ` +
        `${pad(th.fg("dim", "remaining"), remW)} ${th.fg("dim", "source")}`;
      lines.push(row(header));

      const sorted = [...this.entries].sort((a, b) => new Date(a.wakeAt).getTime() - new Date(b.wakeAt).getTime());
      for (const entry of sorted) {
        const remainingMs = new Date(entry.wakeAt).getTime() - Date.now();
        const wake = formatWallClock(entry.wakeAt, Math.max(remainingMs, 0));
        const remaining = remainingMs <= 0 ? "fired" : formatRemaining(remainingMs);
        const scopeLabel = truncate(entry.scopeGlob, scopeW);
        const line =
          ` ${pad(scopeLabel, scopeW)} ${pad(wake, wakeW)} ${pad(remaining, remW)} ${th.fg("dim", entry.source)}`;
        lines.push(row(line));
      }
    }

    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", "esc close")}`));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }
}

// --- extension -----------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // One in-process timer per scope key, plus a single shared footer ticker.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let statusTicker: ReturnType<typeof setInterval> | undefined;
  let lastCtx: ExtensionContext | undefined;

  function clearTimer(scopeKey: string): void {
    const t = timers.get(scopeKey);
    if (t) {
      clearTimeout(t);
      timers.delete(scopeKey);
    }
  }

  function clearAllTimers(): void {
    for (const t of timers.values()) {
      clearTimeout(t);
    }
    timers.clear();
    if (statusTicker) {
      clearInterval(statusTicker);
      statusTicker = undefined;
    }
  }

  function clearLegacyStatus(): void {
    try {
      if (lastCtx?.hasUI) {
        lastCtx.ui.setStatus(LEGACY_STATUS_KEY, undefined);
      }
    } catch {
      // fail open
    }
  }

  function setFooterStatus(): void {
    try {
      clearLegacyStatus();
      if (!lastCtx?.hasUI) {
        return;
      }
      const pending = pendingEntries(loadState());
      if (pending.length === 0) {
        lastCtx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      pending.sort((a, b) => new Date(a.wakeAt).getTime() - new Date(b.wakeAt).getTime());
      const soonest = pending[0];
      const remaining = new Date(soonest.wakeAt).getTime() - Date.now();
      const wallClock = formatWallClock(soonest.wakeAt, remaining);
      const extra = pending.length - 1;
      const suffix = extra > 0 ? ` +${extra} more` : "";
      lastCtx.ui.setStatus(STATUS_KEY, `🐑 sheepdog wake ${wallClock} (in ${formatRemaining(remaining)})${suffix}`);
    } catch {
      // fail open
    }
  }

  // Ticks every second so the footer's HH:mm:ss (sub-minute) precision stays
  // accurate; cheap (string formatting only), so no need for a slower
  // interval the way the old single-timer version used.
  function ensureTicker(): void {
    if (statusTicker) {
      return;
    }
    setFooterStatus();
    statusTicker = setInterval(setFooterStatus, 1_000);
    statusTicker.unref?.();
  }

  function maybeStopTicker(): void {
    if (statusTicker && pendingEntries(loadState()).length === 0) {
      clearInterval(statusTicker);
      statusTicker = undefined;
    }
  }

  function buildResumeMessage(entry: WakeEntry): string {
    const scopeLabel = entry.scopeGlob === CATCHALL_SCOPE ? "(untagged scope)" : entry.scopeGlob;
    const lines = [
      `Rate limit reset timer fired for scope \`${scopeLabel}\`. Continue from the interrupted task.`,
      "First check current status/output, then resume safely.",
      "",
      `Source: ${entry.source}`,
      `Detail: ${entry.sourceExcerpt}`,
      `Scheduled wake: ${formatLocalWakeTime(new Date(entry.wakeAt))}`,
      `Working directory: ${entry.cwd}`,
    ];
    if (entry.modelRef) {
      lines.push(`Detected on model: ${entry.modelRef}`);
    }
    if (entry.sessionFile) {
      lines.push(`Session file: ${entry.sessionFile}`);
    } else if (entry.sessionId) {
      lines.push(`Session id: ${entry.sessionId}`);
    }
    return lines.join("\n");
  }

  function fireWake(scopeKey: string): void {
    try {
      clearTimer(scopeKey);
      const state = loadState();
      const entry = state?.entries[scopeKey];
      if (!state || !entry || entry.status !== "pending") {
        maybeStopTicker();
        return;
      }

      entry.status = "fired";
      entry.updatedAt = new Date().toISOString();
      saveState(state);
      setFooterStatus();
      maybeStopTicker();

      pi.sendUserMessage(buildResumeMessage(entry), { deliverAs: "followUp" });
    } catch {
      // fail open: best-effort extension must not throw out of a timer callback.
    }
  }

  function scheduleWake(entry: WakeEntry): void {
    const scopeKey = entry.scopeGlob;
    clearTimer(scopeKey);

    const delay = new Date(entry.wakeAt).getTime() - Date.now();
    if (delay <= 0) {
      fireWake(scopeKey);
      return;
    }

    const clamped = Math.min(delay, MAX_TIMEOUT_MS);
    const t = setTimeout(() => {
      timers.delete(scopeKey);
      if (clamped < delay) {
        // Long delay beyond Node's max timeout: re-check and reschedule the
        // remaining time instead of firing early.
        const current = loadState()?.entries[scopeKey];
        if (current && current.status === "pending") {
          scheduleWake(current);
        }
        return;
      }
      fireWake(scopeKey);
    }, clamped);
    t.unref?.();
    timers.set(scopeKey, t);

    ensureTicker();
  }

  // Automatic-detection upsert (429 headers / agent_end text). Per-scope
  // dedupe: within the same scope, the earliest wakeAt wins — a repeat
  // detection for a scope already tracked just refreshes bookkeeping instead
  // of pushing the timer later. A detection for a *different* scope always
  // gets (or updates) its own independent entry; unlike the old single-timer
  // design, scopes no longer compete with each other.
  function upsertDetectedState(ctx: ExtensionContext, parsed: ParsedRateLimit, source: "provider-429" | "agent_end"): void {
    const now = new Date();
    const newWakeAt = new Date(now.getTime() + parsed.delayMs).toISOString();
    const modelRef = computeModelRef(ctx);
    const mapper = resolveMapper(modelRef);
    const scopeKey = mapper.scopeGlob;

    const state = loadState() ?? { version: STATE_VERSION, entries: {} };
    const existing = state.entries[scopeKey];
    const existingPending = existing?.status === "pending" ? existing : undefined;

    let entry: WakeEntry;
    if (existingPending && new Date(existingPending.wakeAt).getTime() <= new Date(newWakeAt).getTime()) {
      // The existing pending wake for this scope already fires at or before
      // this new detection would — keep it as-is instead of pushing the
      // timer later.
      entry = { ...existingPending, updatedAt: now.toISOString() };
    } else {
      entry = {
        scopeGlob: scopeKey,
        status: "pending",
        wakeAt: newWakeAt,
        delayMs: parsed.delayMs,
        sourceExcerpt: parsed.excerpt,
        source,
        adapter: mapper.adapter,
        modelRef,
        sessionId: safeSessionId(ctx),
        sessionFile: safeSessionFile(ctx),
        cwd: ctx.cwd,
        createdAt: existingPending?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
    }

    state.entries[scopeKey] = entry;
    saveState(state);
    scheduleWake(entry);
  }

  function lastAssistantMessage(messages: unknown[]): any | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i] as any;
      if (message?.role === "assistant") {
        return message;
      }
    }
    return undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      lastCtx = ctx;
      clearLegacyStatus();
      const state = loadState();
      if (!state) {
        setFooterStatus();
        return;
      }
      for (const entry of Object.values(state.entries)) {
        if (entry.status !== "pending") {
          continue;
        }
        const remaining = new Date(entry.wakeAt).getTime() - Date.now();
        if (remaining <= 0) {
          fireWake(entry.scopeGlob);
        } else {
          scheduleWake(entry);
        }
      }
    } catch {
      // fail open
    }
  });

  // Primary detection path: inspect the raw HTTP response as soon as it
  // arrives, before Pi has even finished consuming/interpreting it. This
  // doesn't depend on how (or whether) a given provider surfaces a 429 as
  // agent_end error text, so it catches cases the text parser below misses.
  pi.on("after_provider_response", (event, ctx) => {
    try {
      lastCtx = ctx;
      if (event.status !== 429) {
        return;
      }

      const parsed = parseProviderRateLimit(event.headers);
      if (!parsed) {
        return;
      }

      upsertDetectedState(ctx, parsed, "provider-429");
    } catch {
      // fail open
    }
  });

  // Fallback detection path: providers/transports that don't expose
  // headers to after_provider_response (or that fail before a response
  // object exists at all) still surface an error message on agent_end.
  pi.on("agent_end", (event, ctx) => {
    try {
      lastCtx = ctx;
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const assistant = lastAssistantMessage(messages);
      if (!assistant || assistant.stopReason !== "error") {
        return;
      }

      const errorMessage = String(assistant.errorMessage ?? "");
      const parsed = parseRateLimitError(errorMessage);
      if (!parsed) {
        return;
      }

      upsertDetectedState(ctx, parsed, "agent_end");
    } catch {
      // fail open
    }
  });

  pi.on("session_shutdown", () => {
    // Do not clear persisted state or cancel any logical wake here — only
    // in-process timers/ticker die with this process. session_start in the
    // next process picks up still-pending entries and reschedules them.
    for (const t of timers.values()) {
      clearTimeout(t);
    }
    timers.clear();
    if (statusTicker) {
      clearInterval(statusTicker);
      statusTicker = undefined;
    }
    clearLegacyStatus();
    try {
      lastCtx?.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // fail open
    }
  });

  pi.registerCommand("sheepdog", {
    description: "Show tracked sheepdog cooldown scopes",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const pending = pendingEntries(loadState());

      // Guard: the overlay component needs a real terminal. In non-TUI modes
      // (rpc/json/print) or when dialog UI isn't available, fall back to the
      // same notify-list this command uses in TUI-less modes.
      if (!ctx.hasUI || ctx.mode !== "tui") {
        if (pending.length === 0) {
          ctx.ui.notify(`No pending sheepdog scopes. Config: ${getConfigPath()}`, "info");
          return;
        }
        pending.sort((a, b) => new Date(a.wakeAt).getTime() - new Date(b.wakeAt).getTime());
        const lines = pending.map((entry) => {
          const remaining = new Date(entry.wakeAt).getTime() - Date.now();
          return `${entry.scopeGlob === CATCHALL_SCOPE ? "(untagged)" : entry.scopeGlob}: ${formatWallClock(entry.wakeAt, remaining)} (in ${formatRemaining(remaining)}), source: ${entry.source}`;
        });
        ctx.ui.notify(`${pending.length} pending sheepdog scope(s):\n${lines.join("\n")}\nConfig: ${getConfigPath()}`, "info");
        return;
      }

      await ctx.ui.custom<undefined>(
        (_tui, theme, _keybindings, done) => new RateLimitPanel(theme, pending, done),
        {
          overlay: true,
          overlayOptions: { anchor: "top-right", width: 74, margin: 2 },
        },
      );
    },
  });

  pi.registerCommand("sheepdog config", {
    description: "Create and validate the sheepdog config",
    handler: async (_args, ctx) => {
      const config = loadConfig(true);
      const lines = [
        `${config.created ? "Created" : "Sheepdog config"}: ${getConfigPath()}`,
        `Valid mapper rules: ${config.rules.length}`,
      ];
      if (config.warnings.length > 0) {
        lines.push("Warnings:", ...config.warnings.map((warning) => `- ${warning}`));
      }
      lines.push(
        "Example mapper:",
        '{ "match": "^openrouter/anthropic/(.+)$", "adapter": "anthropic", "scope": "openrouter/anthropic/*", "args": { "credentialFile": "$HOME/.claude/.credentials.json", "configDir": "$HOME/.claude", "baseUrl": "https://api.anthropic.com" } }',
      );
      ctx.ui.notify(lines.join("\n"), config.warnings.length > 0 ? "warn" : "info");
    },
  });
}
