import type { AdapterId } from "./sheepdog-mapper.ts";
import { redactAndTruncateExcerpt } from "./sheepdog-state.ts";

const SAFETY_BUFFER_MS = 60_000;

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

export interface ParsedRateLimit {
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
function parseGenericRateLimitError(errorMessage: string): ParsedRateLimit | null {
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
    excerpt: redactAndTruncateExcerpt(errorMessage),
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
function parseGenericProviderRateLimit(headers: Record<string, string> | undefined | null): ParsedRateLimit | null {
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
    excerpt: redactAndTruncateExcerpt(excerpt),
  };
}

// --- ordered cooldown interceptors ------------------------------------------

export type DetectorResult =
  | { kind: "no-match" }
  | { kind: "matched"; parsed: ParsedRateLimit }
  | { kind: "stop-generic"; reason: string };

const NO_MATCH: DetectorResult = { kind: "no-match" };

function interceptAdapterHeaders(adapter: AdapterId, headers: Record<string, string> | undefined | null): DetectorResult {
  if (!headers || adapter === "generic") return NO_MATCH;

  // Multiple merged Retry-After values are ambiguous; selected adapter blocks generic guessing.
  const retryAfter = getHeaderCaseInsensitive(headers, "retry-after");
  if (retryAfter?.includes(",")) {
    return { kind: "stop-generic", reason: `${adapter}: ambiguous retry-after header` };
  }
  return NO_MATCH;
}

function interceptAdapterError(_adapter: AdapterId, _errorMessage: string): DetectorResult {
  // ponytail: v1 has no stable provider-specific text format. Add branch when documented.
  return NO_MATCH;
}

export function detectHeaders(adapter: AdapterId, headers: Record<string, string> | undefined | null): DetectorResult {
  const adapterResult = interceptAdapterHeaders(adapter, headers);
  if (adapterResult.kind !== "no-match") return adapterResult;
  const parsed = parseGenericProviderRateLimit(headers);
  return parsed ? { kind: "matched", parsed } : NO_MATCH;
}

export function detectErrorText(adapter: AdapterId, errorMessage: string): DetectorResult {
  const adapterResult = interceptAdapterError(adapter, errorMessage);
  if (adapterResult.kind !== "no-match") return adapterResult;
  const parsed = parseGenericRateLimitError(errorMessage);
  return parsed ? { kind: "matched", parsed } : NO_MATCH;
}
