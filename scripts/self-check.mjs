import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadStateFile, mergeDetectedWakeEntry, normalizeState, updateStateFile } from "../extensions/sheepdog-state.js";

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

const ADAPTER_IDS = new Set(["generic", "anthropic", "openai-compatible"]);
const ANTHROPIC_ARG_NAMES = new Set(["credentialFile", "configDir", "baseUrl"]);
const PATH_ARG_NAMES = new Set(["credentialFile", "configDir"]);

function computeScopeGlob(modelRef) {
  const lastSlash = modelRef?.lastIndexOf("/") ?? -1;
  return lastSlash === -1 ? undefined : `${modelRef.slice(0, lastSlash)}/*`;
}

function expandPathValue(value, home) {
  if (value === "$HOME") return home;
  if (value.startsWith("$HOME/")) return `${home}/${value.slice(6)}`;
  if (value === "~") return home;
  if (value.startsWith("~/")) return `${home}/${value.slice(2)}`;
  return value;
}

function validateArgs(adapter, rawArgs, home) {
  if (rawArgs === undefined) return { args: {} };
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return { warning: "args" };
  const args = {};
  for (const [key, value] of Object.entries(rawArgs)) {
    if (adapter !== "anthropic" || !ANTHROPIC_ARG_NAMES.has(key)) return { warning: key };
    if (typeof value !== "string" || value.length === 0) return { warning: key };
    args[key] = PATH_ARG_NAMES.has(key) ? expandPathValue(value, home) : value;
  }
  return { args };
}

function loadMapperConfig(parsed, home = "/home/alice") {
  const warnings = [];
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.mappers)) return { rules: [], warnings: ["mappers"] };
  const rules = [];
  parsed.mappers.forEach((rule, index) => {
    if (!rule || typeof rule !== "object") return warnings.push(`mappers[${index}]`);
    if (typeof rule.match !== "string" || typeof rule.adapter !== "string" || typeof rule.scope !== "string") return warnings.push(`mappers[${index}]`);
    if (!ADAPTER_IDS.has(rule.adapter)) return warnings.push(`adapter ${rule.adapter}`);
    let regex;
    try {
      regex = new RegExp(rule.match);
    } catch {
      warnings.push(`regex ${index}`);
      return;
    }
    const { args, warning } = validateArgs(rule.adapter, rule.args, home);
    if (warning) return warnings.push(`args ${warning}`);
    rules.push({ regex, adapter: rule.adapter, scope: rule.scope, args });
  });
  return { rules, warnings };
}

function resolveMapper(modelRef, config) {
  for (const rule of config.rules) {
    if (rule.regex.test(modelRef)) return { adapter: rule.adapter, scopeGlob: rule.scope, args: rule.args };
  }
  return { adapter: "generic", scopeGlob: computeScopeGlob(modelRef) ?? "*", args: {} };
}

function checkMapperConfig() {
  const config = loadMapperConfig({
    mappers: [
      { match: "(", adapter: "anthropic", scope: "bad/*" },
      { match: "^bad/", adapter: "bogus", scope: "bad/*" },
      { match: "^badargs/", adapter: "anthropic", scope: "bad/*", args: { token: "x" } },
      { match: "^openrouter/anthropic/(.+)$", adapter: "anthropic", scope: "openrouter/anthropic/*", args: { credentialFile: "$HOME/.claude/.credentials.json", configDir: "~/.claude", baseUrl: "https://api.anthropic.com" } },
      { match: "^openrouter/anthropic/special$", adapter: "generic", scope: "later/*" },
    ],
  });
  assert.equal(config.rules.length, 2);
  assert.equal(config.warnings.length, 3);
  const match = resolveMapper("openrouter/anthropic/claude-sonnet-5", config);
  assert.equal(match.adapter, "anthropic");
  assert.equal(match.scopeGlob, "openrouter/anthropic/*");
  assert.equal(match.args.credentialFile, "/home/alice/.claude/.credentials.json");
  assert.equal(match.args.configDir, "/home/alice/.claude");
  assert.deepEqual(resolveMapper("openai/gpt-5", config), { adapter: "generic", scopeGlob: "openai/*", args: {} });
  assert.equal(resolveMapper("openrouter/anthropic/special", config).scopeGlob, "openrouter/anthropic/*");
}

function checkTimeFormatting() {
  const now = new Date(2026, 6, 14, 10, 0, 0);
  assert.equal(formatLocalWakeTime(new Date(2026, 6, 14, 23, 41), now), "today 23:41");
  assert.equal(formatLocalWakeTime(new Date(2026, 6, 15, 8, 10), now), "tomorrow 08:10");
  assert.equal(formatLocalWakeTime(new Date(2026, 6, 17, 9, 5), now), `${WEEKDAY_FORMAT.format(new Date(2026, 6, 17, 9, 5))} 09:05`);
  assert.equal(formatLocalWakeTime(new Date(2026, 7, 2, 18, 30), now), `${MONTH_DAY_FORMAT.format(new Date(2026, 7, 2, 18, 30))} 18:30`);
  assert.equal(formatLocalWakeTime(new Date(2027, 0, 5, 7, 45), now), `${MONTH_DAY_YEAR_FORMAT.format(new Date(2027, 0, 5, 7, 45))} 07:45`);
}


function checkStateSemantics() {
  const migrated = normalizeState({ version: 1, wakeAt: "2026-07-14T10:00:00.000Z", delayMs: 120000, sourceExcerpt: "provider response 429; retry-after=60" }, { catchallScope: "*" });
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
  const sticky = mergeDetectedWakeEntry(existingManual, {
    scopeGlob: "provider/*",
    wakeAt: "2026-07-14T10:03:00.000Z",
    delayMs: 180000,
    redactedExcerpt: "later auto",
    source: "agent_end",
    cwd: process.cwd(),
    nowIso: "manual-sticky",
  });
  assert.equal(sticky.origin, "manual");
  assert.equal(sticky.wakeAt, existingManual.wakeAt);

  const existingAuto = { ...existingManual, origin: "auto", wakeAt: "2026-07-14T10:01:00.000Z" };
  const earliest = mergeDetectedWakeEntry(existingAuto, {
    scopeGlob: "provider/*",
    wakeAt: "2026-07-14T10:02:00.000Z",
    delayMs: 120000,
    redactedExcerpt: "later auto",
    source: "agent_end",
    cwd: process.cwd(),
    nowIso: "earliest-kept",
  });
  assert.equal(earliest.wakeAt, existingAuto.wakeAt);

  const replaced = mergeDetectedWakeEntry(existingAuto, {
    scopeGlob: "provider/*",
    wakeAt: "2026-07-14T10:00:30.000Z",
    delayMs: 30000,
    redactedExcerpt: "earlier auto",
    source: "agent_end",
    cwd: process.cwd(),
    nowIso: "replaced",
  });
  assert.equal(replaced.wakeAt, "2026-07-14T10:00:30.000Z");
  assert.equal(replaced.originalSource, undefined);

  const existingEditedManual = { ...existingManual, source: "agent_end", originalSource: "provider-429" };
  const preservedManual = mergeDetectedWakeEntry(existingEditedManual, {
    scopeGlob: "provider/*",
    wakeAt: "2026-07-14T10:00:20.000Z",
    delayMs: 20000,
    redactedExcerpt: "earlier auto",
    source: "agent_end",
    cwd: process.cwd(),
    nowIso: "manual-sticky",
  });
  assert.equal(preservedManual.originalSource, "provider-429");
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
      `import { updateStateFile } from ${JSON.stringify(new URL("../extensions/sheepdog-state.js", import.meta.url).pathname)};\nconst [statePath, scopeKey] = process.argv.slice(2);\nupdateStateFile(statePath, (state) => { state.entries[scopeKey] = { scopeGlob: scopeKey, status: "pending", origin: "auto", wakeAt: new Date().toISOString(), delayMs: 1, redactedExcerpt: scopeKey, source: "agent_end", cwd: process.cwd(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; });\n`,
      "utf8",
    );
    const [exitA, exitB] = await Promise.all([runNode(worker, statePath, "a/*"), runNode(worker, statePath, "b/*")]);
    assert.equal(exitA, 0);
    assert.equal(exitB, 0);
    const state = loadStateFile(statePath, { catchallScope: "*" });
    assert.ok(state?.entries["a/*"]);
    assert.ok(state?.entries["b/*"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const mode = process.argv[2];

if (mode === "time") {
  checkTimeFormatting();
  console.log("self-check: time ok");
} else if (mode === "mapper") {
  checkMapperConfig();
  console.log("self-check: mapper ok");
} else if (mode === "state") {
  checkStateSemantics();
  await checkConcurrentMerge();
  console.log("self-check: state ok");
} else {
  console.error(`unknown self-check mode: ${mode || "(missing)"}`);
  process.exit(1);
}
