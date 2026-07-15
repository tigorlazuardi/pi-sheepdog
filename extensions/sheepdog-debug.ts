import * as fs from "node:fs";
import * as path from "node:path";
import { redactAndTruncateExcerpt } from "./sheepdog-state.ts";

const SENSITIVE_FIELDS = new Set([
  "authorization", "proxyauthorization", "authentication", "auth", "bearer",
  "cookie", "setcookie", "apikey", "xapikey", "passwd", "credentialfile", "configdir", "credentialcontents",
]);
const SENSITIVE_FIELD_PARTS = [
  "authorization", "apikey", "accesstoken", "refreshtoken", "clientsecret", "secretkey", "signingkey",
];
const SENSITIVE_FIELD_SUFFIXES = ["token", "password", "secret", "privatekey", "privatekeypem", "credential", "credentials"];
const MAX_DEBUG_STRING = 400;

function normalizedField(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveField(key: string): boolean {
  const normalized = normalizedField(key);
  return SENSITIVE_FIELDS.has(normalized)
    || SENSITIVE_FIELD_PARTS.some((part) => normalized.includes(part))
    || SENSITIVE_FIELD_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return redactAndTruncateExcerpt(value, MAX_DEBUG_STRING);
    const path = url.pathname === "/" ? "" : "/[REDACTED]";
    const query = [...new Set(url.searchParams.keys())].map((name) => `${encodeURIComponent(name)}=[REDACTED]`).join("&");
    return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ""}${url.hash ? "#[REDACTED]" : ""}`;
  } catch {
    return redactAndTruncateExcerpt(value, MAX_DEBUG_STRING);
  }
}

function sanitize(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (isSensitiveField(key)) return "[REDACTED]";
  if (typeof value === "string") {
    // ponytail: URL-valued debug fields keep origin/query names only; path/query/userinfo may carry opaque credentials.
    if (/(?:url|uri|endpoint)$/i.test(normalizedField(key))) return sanitizeUrl(value);
    return redactAndTruncateExcerpt(value, MAX_DEBUG_STRING);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, "", seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([field, item]) => [field, sanitize(item, field, seen)]));
}

export function appendPanelCrudDebugEvent(
  debugPath: string,
  operation: "create" | "edit" | "delete",
  scope: string,
  now = new Date(),
): void {
  // ponytail: fixed fields prevent panel forms, provider headers, or raw bodies from entering support logs.
  appendDebugEvent(debugPath, `panel_${operation}`, { scope, status: "succeeded" }, now);
}

export function appendDebugEvent(debugPath: string, event: string, details: Record<string, unknown> = {}, now = new Date()): void {
  try {
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    const safeEvent = typeof event === "string" && /^[a-z][a-z0-9_]*$/.test(event) ? event : "invalid_event";
    const fd = fs.openSync(debugPath, "a", 0o600);
    try {
      // append mode does not apply creation mode to an existing file; tighten it before secrets can be written.
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ ...sanitize(details) as object, timestamp: now.toISOString(), event: safeEvent })}\n`, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ponytail: debug logging is best-effort; add rotation/error surfacing if support logs become operationally critical.
  }
}
