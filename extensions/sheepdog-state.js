import * as fs from "node:fs";
import * as path from "node:path";

export const STATE_VERSION = 3;

export function normalizeWakeStatus(value) {
  return value === "pending" || value === "fired" || value === "cancelled" || value === "expired"
    ? value
    : "cancelled";
}

export function normalizeWakeEntry(raw, scopeKey, options = {}) {
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
  const redactedExcerpt =
    typeof entry.redactedExcerpt === "string"
      ? entry.redactedExcerpt
      : typeof entry.sourceExcerpt === "string"
        ? entry.sourceExcerpt
        : "";
  return {
    scopeGlob: typeof entry.scopeGlob === "string" && entry.scopeGlob.length > 0 ? entry.scopeGlob : scopeKey,
    status: normalizeWakeStatus(entry.status),
    origin: entry.origin === "manual" ? "manual" : "auto",
    wakeAt,
    delayMs: typeof entry.delayMs === "number" ? entry.delayMs : 0,
    redactedExcerpt,
    source: entry.source === "provider-429" ? "provider-429" : "agent_end",
    originalSource: entry.originalSource === "provider-429" || entry.originalSource === "agent_end" ? entry.originalSource : undefined,
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

export function migrateLegacyEntry(legacy, scopeKey, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const nowIso = options.nowIso ?? new Date().toISOString();
  const redactedExcerpt = typeof legacy.sourceExcerpt === "string" ? legacy.sourceExcerpt : "";
  const source = redactedExcerpt.startsWith("provider response 429;") ? "provider-429" : "agent_end";
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

export function normalizeState(parsed, options = {}) {
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

export function loadStateFile(statePath, options = {}) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return normalizeState(JSON.parse(raw), options);
  } catch {
    return null;
  }
}

export function writeStateFile(statePath, state) {
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempPath, statePath);
}

export function withFileLock(lockPath, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const waitMs = options.waitMs ?? 25;
  const deadline = Date.now() + timeoutMs;

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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export function updateStateFile(statePath, updater, options = {}) {
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
    redactedExcerpt: next.redactedExcerpt,
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
