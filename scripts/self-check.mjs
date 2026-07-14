import assert from "node:assert/strict";

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

const mode = process.argv[2];

if (mode === "time") {
  checkTimeFormatting();
  console.log("self-check: time ok");
} else if (mode === "mapper") {
  checkMapperConfig();
  console.log("self-check: mapper ok");
} else {
  console.error(`unknown self-check mode: ${mode || "(missing)"}`);
  process.exit(1);
}
