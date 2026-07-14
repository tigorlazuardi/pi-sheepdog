import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const WEEKDAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
});

const MONTH_DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const MONTH_DAY_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function localDayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function diffLocalDays(left, right) {
  return Math.round((localDayStart(left) - localDayStart(right)) / 86_400_000);
}

function formatLocalWakeTime(date, now = new Date()) {
  const dayDiff = diffLocalDays(date, now);
  const time = TIME_FORMAT.format(date);

  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${WEEKDAY_FORMAT.format(date)} ${time}`;
  if (date.getFullYear() === now.getFullYear()) return `${MONTH_DAY_FORMAT.format(date)} ${time}`;
  return `${MONTH_DAY_YEAR_FORMAT.format(date)} ${time}`;
}

function checkTimeFormatting() {
  const now = new Date(2026, 6, 14, 10, 0, 0);
  assert.equal(formatLocalWakeTime(new Date(2026, 6, 14, 23, 41), now), "today 23:41");
  assert.equal(formatLocalWakeTime(new Date(2026, 6, 15, 8, 10), now), "tomorrow 08:10");
  assert.equal(formatLocalWakeTime(new Date(2026, 6, 17, 9, 5), now), `${WEEKDAY_FORMAT.format(new Date(2026, 6, 17, 9, 5))} 09:05`);
  assert.equal(formatLocalWakeTime(new Date(2026, 7, 2, 18, 30), now), `${MONTH_DAY_FORMAT.format(new Date(2026, 7, 2, 18, 30))} 18:30`);
  assert.equal(formatLocalWakeTime(new Date(2027, 0, 5, 7, 45), now), `${MONTH_DAY_YEAR_FORMAT.format(new Date(2027, 0, 5, 7, 45))} 07:45`);
}

function migrateLegacyEntry(legacy, scopeKey) {
  const redactedExcerpt = typeof legacy.sourceExcerpt === "string" ? legacy.sourceExcerpt : "";
  const source = redactedExcerpt.startsWith("provider response 429;") ? "provider-429" : "agent_end";
  const now = new Date().toISOString();
  return {
    scopeGlob: scopeKey,
    status: ["pending", "fired", "cancelled", "expired"].includes(legacy.status) ? legacy.status : "cancelled",
    origin: "auto",
    wakeAt: typeof legacy.wakeAt === "string" ? legacy.wakeAt : now,
    delayMs: typeof legacy.delayMs === "number" ? legacy.delayMs : 0,
    redactedExcerpt,
    source,
    modelRef: typeof legacy.modelRef === "string" ? legacy.modelRef : undefined,
    sessionId: typeof legacy.sessionId === "string" ? legacy.sessionId : undefined,
    sessionFile: typeof legacy.sessionFile === "string" ? legacy.sessionFile : undefined,
    cwd: typeof legacy.cwd === "string" ? legacy.cwd : process.cwd(),
    createdAt: typeof legacy.createdAt === "string" ? legacy.createdAt : now,
    updatedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : now,
  };
}

function normalizeWakeEntry(raw, scopeKey) {
  if (!raw || typeof raw !== "object" || typeof raw.wakeAt !== "string") {
    return null;
  }
  const now = new Date().toISOString();
  return {
    scopeGlob: typeof raw.scopeGlob === "string" && raw.scopeGlob.length > 0 ? raw.scopeGlob : scopeKey,
    status: ["pending", "fired", "cancelled", "expired"].includes(raw.status) ? raw.status : "cancelled",
    origin: raw.origin === "manual" ? "manual" : "auto",
    wakeAt: raw.wakeAt,
    delayMs: typeof raw.delayMs === "number" ? raw.delayMs : 0,
    redactedExcerpt: typeof raw.redactedExcerpt === "string" ? raw.redactedExcerpt : typeof raw.sourceExcerpt === "string" ? raw.sourceExcerpt : "",
    source: raw.source === "provider-429" ? "provider-429" : "agent_end",
    originalSource: raw.originalSource === "provider-429" || raw.originalSource === "agent_end" ? raw.originalSource : undefined,
    adapter: typeof raw.adapter === "string" ? raw.adapter : undefined,
    humanNotifiedAt: typeof raw.humanNotifiedAt === "string" ? raw.humanNotifiedAt : undefined,
    modelRef: typeof raw.modelRef === "string" ? raw.modelRef : undefined,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    sessionFile: typeof raw.sessionFile === "string" ? raw.sessionFile : undefined,
    cwd: typeof raw.cwd === "string" ? raw.cwd : process.cwd(),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : now,
  };
}

function normalizeState(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  if (parsed.version === 1 && typeof parsed.wakeAt === "string") {
    const scopeKey = typeof parsed.scopeGlob === "string" && parsed.scopeGlob.length > 0 ? parsed.scopeGlob : "*";
    return { version: 3, entries: { [scopeKey]: migrateLegacyEntry(parsed, scopeKey) } };
  }
  if (!parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
    return null;
  }
  const entries = {};
  for (const [scopeKey, raw] of Object.entries(parsed.entries)) {
    const entry = normalizeWakeEntry(raw, scopeKey);
    if (entry) entries[scopeKey] = entry;
  }
  return { version: 3, entries };
}

function mergeAutoEntry(existing, nextWakeAtIso, nextDelayMs, excerpt) {
  if (existing?.status === "pending" && existing.origin === "manual") {
    return { ...existing, updatedAt: "manual-sticky" };
  }
  if (existing?.status === "pending" && new Date(existing.wakeAt).getTime() <= new Date(nextWakeAtIso).getTime()) {
    return { ...existing, updatedAt: "earliest-kept" };
  }
  return {
    scopeGlob: existing?.scopeGlob ?? "provider/*",
    status: "pending",
    origin: "auto",
    wakeAt: nextWakeAtIso,
    delayMs: nextDelayMs,
    redactedExcerpt: excerpt,
    source: "agent_end",
    originalSource: existing?.origin === "manual" ? existing.originalSource : undefined,
    createdAt: existing?.createdAt ?? "created",
    updatedAt: "replaced",
    cwd: existing?.cwd ?? process.cwd(),
  };
}

function checkStateSemantics() {
  const migrated = normalizeState({ version: 1, wakeAt: "2026-07-14T10:00:00.000Z", delayMs: 120000, sourceExcerpt: "provider response 429; retry-after=60" });
  assert.equal(migrated.version, 3);
  assert.equal(migrated.entries["*"].redactedExcerpt, "provider response 429; retry-after=60");
  assert.equal(migrated.entries["*"].originalSource, undefined);

  const existingManual = {
    scopeGlob: "provider/*",
    status: "pending",
    origin: "manual",
    wakeAt: "2026-07-14T10:01:00.000Z",
    delayMs: 60000,
    redactedExcerpt: "manual",
    source: "agent_end",
    originalSource: "provider-429",
    cwd: process.cwd(),
    createdAt: "created",
    updatedAt: "updated",
  };
  const sticky = mergeAutoEntry(existingManual, "2026-07-14T10:03:00.000Z", 180000, "later auto");
  assert.equal(sticky.origin, "manual");
  assert.equal(sticky.wakeAt, existingManual.wakeAt);

  const existingAuto = { ...existingManual, origin: "auto", wakeAt: "2026-07-14T10:01:00.000Z" };
  const earliest = mergeAutoEntry(existingAuto, "2026-07-14T10:02:00.000Z", 120000, "later auto");
  assert.equal(earliest.wakeAt, existingAuto.wakeAt);

  const replaced = mergeAutoEntry(existingAuto, "2026-07-14T10:00:30.000Z", 30000, "earlier auto");
  assert.equal(replaced.wakeAt, "2026-07-14T10:00:30.000Z");
  assert.equal(replaced.originalSource, undefined);

  const existingEditedManual = { ...existingManual, source: "agent_end", originalSource: "provider-429" };
  const preservedManual = mergeAutoEntry(existingEditedManual, "2026-07-14T10:00:20.000Z", 20000, "earlier auto");
  assert.equal(preservedManual.originalSource, "provider-429");
}

function withFileLock(lockPath, fn) {
  const deadline = Date.now() + 1000;
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
      if (error?.code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function updateStateFile(statePath, updater) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  return withFileLock(lockPath, () => {
    let state = { version: 3, entries: {} };
    try {
      state = normalizeState(JSON.parse(fs.readFileSync(statePath, "utf8"))) ?? state;
    } catch {}
    const result = updater(state);
    const tempPath = `${statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tempPath, statePath);
    return result;
  });
}

function runNode(scriptPath, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function checkConcurrentMerge() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sheepdog-self-check-"));
  try {
    const worker = path.join(root, "worker.mjs");
    const statePath = path.join(root, "state.json");
    fs.writeFileSync(
      worker,
      `import fs from "node:fs";\nconst [statePath, scopeKey] = process.argv.slice(2);\nfunction withFileLock(lockPath, fn) { const deadline = Date.now() + 1000; while (true) { try { const fd = fs.openSync(lockPath, "wx"); try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lockPath, { force: true }); } } catch (error) { if (error?.code !== "EEXIST" || Date.now() >= deadline) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } } }\nwithFileLock(statePath + ".lock", () => { let state = { version: 3, entries: {} }; try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {} state.entries[scopeKey] = { scopeGlob: scopeKey, status: "pending", origin: "auto", wakeAt: new Date().toISOString(), delayMs: 1, redactedExcerpt: scopeKey, source: "agent_end", cwd: process.cwd(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; const tempPath = statePath + "." + process.pid + ".tmp"; fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8"); fs.renameSync(tempPath, statePath); });\n`,
      "utf8",
    );
    const [exitA, exitB] = await Promise.all([runNode(worker, statePath, "a/*"), runNode(worker, statePath, "b/*")]);
    assert.equal(exitA, 0);
    assert.equal(exitB, 0);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.ok(state.entries["a/*"]);
    assert.ok(state.entries["b/*"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const mode = process.argv[2];

if (mode === "time") {
  checkTimeFormatting();
  console.log("self-check: time ok");
} else if (mode === "state") {
  checkStateSemantics();
  await checkConcurrentMerge();
  console.log("self-check: state ok");
} else {
  console.error(`unknown self-check mode: ${mode || "(missing)"}`);
  process.exit(1);
}
