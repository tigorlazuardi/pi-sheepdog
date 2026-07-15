import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const STATE_VERSION = 3;
export const MAX_PERSISTED_EXCERPT = 400;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer|basic)?\s*[^\s,;]+/gi, "$1[REDACTED]"],
  [/(\b(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|set-cookie)\b\s*[:=]\s*)((?:["'])?)[^\s,;"']+\2/gi, "$1[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]"],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, "[REDACTED_PRIVATE_KEY]"],
];

export function redactAndTruncateExcerpt(value, maxLength = MAX_PERSISTED_EXCERPT) {
  let safe = typeof value === "string" ? value : "";
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    safe = safe.replace(pattern, replacement);
  }
  return safe.slice(0, maxLength);
}

export function normalizeWakeStatus(value) {
  return value === "pending" || value === "fired" || value === "cancelled" || value === "expired"
    ? value
    : "cancelled";
}

export function normalizeWakeEntry(raw, scopeKey, options: any = {}) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cwd = options.cwd ?? process.cwd();
  const nowIso = options.nowIso ?? new Date().toISOString();
  const entry = raw;
  const wakeAt = typeof entry.wakeAt === "string" ? entry.wakeAt : undefined;
  if (!wakeAt) {
    return null;
  }
  const redactedExcerpt = redactAndTruncateExcerpt(
    typeof entry.redactedExcerpt === "string"
      ? entry.redactedExcerpt
      : typeof entry.sourceExcerpt === "string"
        ? entry.sourceExcerpt
        : "",
  );
  const origin = entry.origin === "manual" ? "manual" : "auto";
  return {
    scopeGlob: typeof entry.scopeGlob === "string" && entry.scopeGlob.length > 0 ? entry.scopeGlob : scopeKey,
    status: normalizeWakeStatus(entry.status),
    origin,
    wakeAt,
    delayMs: typeof entry.delayMs === "number" ? entry.delayMs : 0,
    redactedExcerpt,
    source: entry.source === "provider-429" ? "provider-429" : "agent_end",
    originalSource:
      origin === "manual" && (entry.originalSource === "provider-429" || entry.originalSource === "agent_end")
        ? entry.originalSource
        : undefined,
    adapter: typeof entry.adapter === "string" ? entry.adapter : undefined,
    humanNotifiedAt: typeof entry.humanNotifiedAt === "string" ? entry.humanNotifiedAt : undefined,
    modelRef: typeof entry.modelRef === "string" ? entry.modelRef : undefined,
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : undefined,
    sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : undefined,
    cwd: typeof entry.cwd === "string" ? entry.cwd : cwd,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : nowIso,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : nowIso,
  };
}

export function migrateLegacyEntry(legacy, scopeKey, options: any = {}) {
  const cwd = options.cwd ?? process.cwd();
  const nowIso = options.nowIso ?? new Date().toISOString();
  const sourceExcerpt = typeof legacy.sourceExcerpt === "string" ? legacy.sourceExcerpt : "";
  const source = sourceExcerpt.startsWith("provider response 429;") ? "provider-429" : "agent_end";
  const redactedExcerpt = redactAndTruncateExcerpt(sourceExcerpt);
  return {
    scopeGlob: scopeKey,
    status: normalizeWakeStatus(legacy.status),
    origin: "auto",
    wakeAt: typeof legacy.wakeAt === "string" ? legacy.wakeAt : nowIso,
    delayMs: typeof legacy.delayMs === "number" ? legacy.delayMs : 0,
    redactedExcerpt,
    source,
    modelRef: typeof legacy.modelRef === "string" ? legacy.modelRef : undefined,
    sessionId: typeof legacy.sessionId === "string" ? legacy.sessionId : undefined,
    sessionFile: typeof legacy.sessionFile === "string" ? legacy.sessionFile : undefined,
    cwd: typeof legacy.cwd === "string" ? legacy.cwd : cwd,
    createdAt: typeof legacy.createdAt === "string" ? legacy.createdAt : nowIso,
    updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : nowIso,
  };
}

function looksLikeLegacyV1(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return false;
  }
  return parsed.version === 1 && typeof parsed.wakeAt === "string";
}

function looksLikeEntriesRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeState(parsed, options: any = {}) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const cwd = options.cwd ?? process.cwd();
  const catchallScope = options.catchallScope ?? "*";

  if (looksLikeLegacyV1(parsed)) {
    const scopeKey = typeof parsed.scopeGlob === "string" && parsed.scopeGlob.length > 0 ? parsed.scopeGlob : catchallScope;
    return { version: STATE_VERSION, entries: { [scopeKey]: migrateLegacyEntry(parsed, scopeKey, { cwd }) } };
  }

  if (!looksLikeEntriesRecord(parsed.entries)) {
    return null;
  }

  const entries = {};
  for (const [scopeKey, rawEntry] of Object.entries(parsed.entries)) {
    const normalized = normalizeWakeEntry(rawEntry, scopeKey, { cwd });
    if (normalized) {
      entries[scopeKey] = normalized;
    }
  }
  return { version: STATE_VERSION, entries };
}

export function loadStateFile(statePath, options: any = {}) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return normalizeState(JSON.parse(raw), options);
  } catch {
    return null;
  }
}

export function writeStateFile(statePath, state) {
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const safeState = normalizeState(state) ?? { version: STATE_VERSION, entries: {} };
  fs.writeFileSync(tempPath, JSON.stringify(safeState, null, 2), "utf8");
  fs.renameSync(tempPath, statePath);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function reclaimStaleLock(lockPath, staleMs, now) {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimFd;
  try {
    reclaimFd = fs.openSync(reclaimPath, "wx");
    const raw = fs.readFileSync(lockPath, "utf8");
    const owner = JSON.parse(raw);
    if (
      owner?.hostname !== os.hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      typeof owner.createdAtMs !== "number" ||
      now - owner.createdAtMs < staleMs ||
      processIsAlive(owner.pid)
    ) {
      return false;
    }
    fs.rmSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    if (reclaimFd !== undefined) fs.closeSync(reclaimFd);
    fs.rmSync(reclaimPath, { force: true });
  }
}

export function withFileLock(lockPath, fn, options: any = {}) {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const waitMs = options.waitMs ?? 25;
  const staleMs = options.staleMs ?? 30_000;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  while (true) {
    let fd;
    const ownerId = randomUUID();
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAtMs: now(), ownerId }), "utf8");
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        fd = undefined;
        try {
          const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (owner?.ownerId === ownerId) fs.rmSync(lockPath);
        } catch {
          // Lock disappeared or changed ownership; never remove another owner's lock.
        }
      }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const currentTime = now();
      if (reclaimStaleLock(lockPath, staleMs, currentTime)) continue;
      if (currentTime >= deadline) {
        throw new Error(`Timed out acquiring state lock ${lockPath}; state update was not written`, { cause: error });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export function updateStateFile(statePath, updater, options: any = {}) {
  const cwd = options.cwd ?? process.cwd();
  const catchallScope = options.catchallScope ?? "*";
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  return withFileLock(`${statePath}.lock`, () => {
    const state = loadStateFile(statePath, { cwd, catchallScope }) ?? { version: STATE_VERSION, entries: {} };
    const result = updater(state);
    writeStateFile(statePath, state);
    return result;
  }, options.lockOptions);
}

export function mergeDetectedWakeEntry(existing, next) {
  if (existing?.status === "pending" && existing.origin === "manual") {
    return {
      ...existing,
      updatedAt: next.nowIso,
    };
  }

  if (existing?.status === "pending" && new Date(existing.wakeAt).getTime() <= new Date(next.wakeAt).getTime()) {
    return {
      ...existing,
      updatedAt: next.nowIso,
    };
  }

  return {
    scopeGlob: next.scopeGlob,
    status: "pending",
    origin: "auto",
    wakeAt: next.wakeAt,
    delayMs: next.delayMs,
    redactedExcerpt: redactAndTruncateExcerpt(next.redactedExcerpt),
    source: next.source,
    adapter: next.adapter ?? existing?.adapter,
    humanNotifiedAt: existing?.humanNotifiedAt,
    modelRef: next.modelRef,
    sessionId: next.sessionId,
    sessionFile: next.sessionFile,
    cwd: next.cwd,
    createdAt: existing?.createdAt ?? next.nowIso,
    updatedAt: next.nowIso,
  };
}
