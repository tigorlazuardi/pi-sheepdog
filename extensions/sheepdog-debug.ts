import * as fs from "node:fs";
import * as path from "node:path";
import { redactAndTruncateExcerpt } from "./sheepdog-state.ts";

const SENSITIVE_FIELDS = new Set([
  "authorization", "proxyauthorization", "authentication", "auth", "authtoken", "bearer", "bearertoken",
  "cookie", "setcookie", "apikey", "xapikey", "token", "accesstoken", "refreshtoken", "xauthtoken",
  "password", "passwd", "secret", "clientsecret", "privatekey", "sshprivatekey", "credentialfile",
  "configdir", "credentialcontents",
]);
const MAX_DEBUG_STRING = 400;

function sanitize(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_FIELDS.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase())) return "[REDACTED]";
  if (typeof value === "string") return redactAndTruncateExcerpt(value, MAX_DEBUG_STRING);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, "", seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([field, item]) => [field, sanitize(item, field, seen)]));
}

export function appendDebugEvent(debugPath: string, event: string, details: Record<string, unknown> = {}, now = new Date()): void {
  try {
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    const safeEvent = typeof event === "string" && /^[a-z][a-z0-9_]*$/.test(event) ? event : "invalid_event";
    fs.appendFileSync(debugPath, `${JSON.stringify({ ...sanitize(details) as object, timestamp: now.toISOString(), event: safeEvent })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // ponytail: debug logging is best-effort; add rotation/error surfacing if support logs become operationally critical.
  }
}
