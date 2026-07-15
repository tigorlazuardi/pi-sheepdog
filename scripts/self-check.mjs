import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendDebugEvent, appendPanelCrudDebugEvent } from "../extensions/sheepdog-debug.ts";
import { consumeDetectorResult, detectErrorText, detectHeaders } from "../extensions/sheepdog-detector.ts";
import { loadMapperConfig, resolveMapper } from "../extensions/sheepdog-mapper.ts";
import { loadStateFile, mergeDetectedWakeEntry, normalizeState, redactAndTruncateExcerpt, reportStateLockFailure, StateLockTimeoutError, updateStateFile, withFileLock } from "../extensions/sheepdog-state.ts";

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

function checkDetection() {
  const header = detectHeaders("generic", { "Retry-After": "120" });
  assert.equal(header.kind, "matched");
  assert.equal(header.parsed.delayMs, 180_000);
  for (const adapter of ["anthropic", "openai-compatible"]) {
    assert.equal(detectHeaders(adapter, { "Retry-After": "Wed, 21 Oct 2099 07:28:00 GMT" }).kind, "matched");
  }
  const blocked = detectHeaders("anthropic", { "Retry-After": "60, 120" });
  const warnings = [];
  assert.equal(consumeDetectorResult(blocked, (reason) => warnings.push(reason)), null);
  assert.deepEqual(warnings, ["anthropic: ambiguous retry-after header"]);

  const text = detectErrorText("generic", "Rate limit: retry after 2m");
  assert.equal(text.kind, "matched");
  assert.equal(text.parsed.delayMs, 180_000);
  assert.equal(detectErrorText("generic", "try again in 2m").kind, "no-match");
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
  }, "/home/alice");
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


function checkRedaction() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sheepdog-debug-check-"));
  const debugPath = path.join(root, "debug.log");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";
  const privateKey = "-----BEGIN PRIVATE KEY-----\ncredential-contents\n-----END PRIVATE KEY-----";
  const standaloneSecrets = [
    "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH",
    "ghp_11AA22BB33CC44DD55EE66FF77GG88HH",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-ant-api03-11AA22BB33CC44DD55EE66FF77GG88HH",
    "sk-proj-11AA22BB33CC44DD55EE66FF77GG88HH",
  ];
  const urlPassword = "proxy-password-secret";
  const payload = `Authorization: Bearer auth-secret Cookie: sid=cookie-secret api_key=key-secret token=token-secret password=password-secret secret=generic-secret jwt=${jwt} ${privateKey} ${standaloneSecrets.join(" ")} ${"provider-payload-".repeat(80)}`;
  const forbidden = ["auth-secret", "cookie-secret", "key-secret", "token-secret", "password-secret", "generic-secret", jwt, "credential-contents", "/home/alice/.credentials.json", "/home/alice/.config", "adapter-token", urlPassword, ...standaloneSecrets];

  try {
    fs.writeFileSync(debugPath, "", { mode: 0o644 });
    fs.chmodSync(debugPath, 0o644);
    appendDebugEvent(debugPath, "detection_matched", {
      excerpt: payload,
      standaloneTokens: standaloneSecrets,
      authorization: "Bearer nested-auth",
      credentialFile: "/home/alice/.credentials.json",
      configDir: "/home/alice/.config",
      credentialContents: "credential-file-secret",
      args: {
        token: "adapter-token",
        baseUrl: `https://proxy-user:${urlPassword}@api.example.test`,
        nested: [{ headers: { "X-API-Key": "nested-api-key", cookie: "nested-cookie" } }],
      },
      private_key: "nested-private-key",
      githubToken: "github-field-secret",
      credentials: { username: "alice", password: "credential-password" },
      privateKeyPem: "pem-field-secret",
    }, new Date("2026-07-15T00:00:00.000Z"));
    appendDebugEvent(debugPath, "wake_skipped", { scope: "anthropic/*", reason: "missing_or_terminal" });
    for (const operation of ["create", "edit", "delete"]) {
      appendPanelCrudDebugEvent(debugPath, operation, "anthropic/*");
    }
    const raw = fs.readFileSync(debugPath, "utf8");
    const [event, wakeSkipped, ...panelEvents] = raw.trim().split("\n").map((line) => JSON.parse(line));
    for (const secret of [...forbidden, "nested-auth", "credential-file-secret", "nested-api-key", "nested-cookie", "nested-private-key", "github-field-secret", "alice", "credential-password", "pem-field-secret"]) assert.ok(!raw.includes(secret), `debug log leaked ${secret}`);
    assert.equal(event.event, "detection_matched");
    assert.equal(event.timestamp, "2026-07-15T00:00:00.000Z");
    assert.deepEqual(event.standaloneTokens, [
      "[REDACTED_GITHUB_TOKEN]",
      "[REDACTED_GITHUB_TOKEN]",
      "[REDACTED_AWS_ACCESS_KEY]",
      "[REDACTED_ANTHROPIC_KEY]",
      "[REDACTED_OPENAI_KEY]",
    ]);
    assert.equal(event.authorization, "[REDACTED]");
    assert.equal(event.credentialFile, "[REDACTED]");
    assert.equal(event.args.token, "[REDACTED]");
    assert.equal(event.args.nested[0].headers["X-API-Key"], "[REDACTED]");
    assert.equal(event.private_key, "[REDACTED]");
    assert.equal(event.githubToken, "[REDACTED]");
    assert.equal(event.credentials, "[REDACTED]");
    assert.equal(event.privateKeyPem, "[REDACTED]");
    assert.equal(event.args.baseUrl, "https://[REDACTED]@api.example.test");
    assert.ok(event.excerpt.length <= 400);
    assert.deepEqual({ event: wakeSkipped.event, scope: wakeSkipped.scope, reason: wakeSkipped.reason }, {
      event: "wake_skipped",
      scope: "anthropic/*",
      reason: "missing_or_terminal",
    });
    assert.deepEqual(panelEvents.map(({ event, scope, status }) => ({ event, scope, status })), [
      { event: "panel_create", scope: "anthropic/*", status: "succeeded" },
      { event: "panel_edit", scope: "anthropic/*", status: "succeeded" },
      { event: "panel_delete", scope: "anthropic/*", status: "succeeded" },
    ]);
    assert.equal(raw.split("\n").filter(Boolean).length, 5);
    assert.equal(fs.statSync(debugPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function checkStateSemantics() {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature";
  const cookieSecret = "COOKIE_SECRET_98f5";
  const quotedSecret = "quoted multiword secret 42";
  const jsonApiKey = "JSON_API_KEY_42";
  const jsonToken = "JSON_TOKEN_42";
  const jsonAuth = "JSON_BEARER_42";
  const authenticationSecret = "RUNTIME_AUTH_SECRET_42";
  const escapedApiKey = "ESCAPED_NESTED_API_KEY_42";
  const runtimeProbe = `authentication: Bearer ${authenticationSecret} payload={\\"error\\":{\\"api_key\\":\\"${escapedApiKey}\\"}}`;
  const secrets = `Authorization: Bearer top-secret Cookie: theme=dark; sessionid=${cookieSecret}\napi_key="${quotedSecret}" token='tok-value' password=hunter2 jwt=${jwt}\nprovider={"error":{"api_key":"${jsonApiKey}","token": "${jsonToken}","authorization":"Bearer ${jsonAuth}"}} ${runtimeProbe}`;
  const secretValues = ["top-secret", cookieSecret, quotedSecret, "tok-value", "hunter2", jwt, jsonApiKey, jsonToken, jsonAuth, authenticationSecret, escapedApiKey];
  const safe = redactAndTruncateExcerpt(`${secrets} ${"x".repeat(500)}`);
  assert.equal(safe.length, 400);
  for (const secret of secretValues) assert.ok(!safe.includes(secret));
  assert.match(safe, /Authorization: \[REDACTED\]/);
  assert.match(safe, /api_key=\[REDACTED\]/);
  assert.match(safe, /"api_key":\[REDACTED\]/);
  assert.match(safe, /"token": \[REDACTED\]/);

  const migrated = normalizeState({ version: 1, wakeAt: "2026-07-14T10:00:00.000Z", delayMs: 120000, sourceExcerpt: `provider response 429; ${secrets}` }, { catchallScope: "*" });
  assert.equal(migrated.version, 3);
  for (const secret of secretValues) assert.ok(!migrated.entries["*"].redactedExcerpt.includes(secret));
  assert.equal(migrated.entries["*"].source, "provider-429");
  assert.equal(migrated.entries["*"].originalSource, undefined);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sheepdog-redaction-check-"));
  try {
    const statePath = path.join(root, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, wakeAt: "2026-07-14T10:00:00.000Z", sourceExcerpt: runtimeProbe }));
    updateStateFile(statePath, () => undefined, { catchallScope: "*" });
    const persistedMigration = fs.readFileSync(statePath, "utf8");
    for (const secret of [authenticationSecret, escapedApiKey]) assert.ok(!persistedMigration.includes(secret));

    updateStateFile(statePath, (state) => {
      state.entries["*"].redactedExcerpt = runtimeProbe;
    });
    const persistedV3Write = fs.readFileSync(statePath, "utf8");
    for (const secret of [authenticationSecret, escapedApiKey]) assert.ok(!persistedV3Write.includes(secret));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const warnings = [];
  reportStateLockFailure(new StateLockTimeoutError("raw path and SECRET must stay hidden"), "self-check", (message) => warnings.push(message));
  reportStateLockFailure(new Error("unrelated"), "self-check", (message) => warnings.push(message));
  assert.deepEqual(warnings, ["[sheepdog] state update skipped: lock timeout (self-check)"]);
  assert.ok(!warnings[0].includes("SECRET"));

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

  const v2Manual = normalizeState({
    version: 2,
    entries: {
      "provider/*": {
        ...existingManual,
        origin: undefined,
        source: "manual",
        sourceExcerpt: "manual: set via /rate-limit-wakeup-set (1m)",
      },
    },
  }).entries["provider/*"];
  const preservedV2Manual = mergeDetectedWakeEntry(v2Manual, {
    scopeGlob: "provider/*",
    wakeAt: "2026-07-14T10:00:20.000Z",
    delayMs: 20000,
    redactedExcerpt: "earlier auto",
    source: "agent_end",
    cwd: process.cwd(),
    nowIso: "v2-manual-sticky",
  });
  assert.equal(v2Manual.origin, "manual");
  assert.equal(preservedV2Manual.wakeAt, existingManual.wakeAt);

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
    const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath, ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function checkLockRecovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sheepdog-lock-check-"));
  const lockPath = path.join(root, "state.json.lock");
  try {
    const writeLock = (owner) => {
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner));
    };
    const readLock = () => JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));

    writeLock({ pid: process.pid, hostname: os.hostname(), createdAtMs: 0, ownerId: "live" });
    assert.throws(
      () => withFileLock(lockPath, () => assert.fail("live lock entered"), { timeoutMs: 0, staleMs: 1, waitMs: 1 }),
      /Timed out acquiring state lock/,
    );
    assert.equal(readLock().ownerId, "live");
    assert.throws(
      () => updateStateFile(path.join(root, "state.json"), () => assert.fail("locked update entered"), {
        lockOptions: { timeoutMs: 0, staleMs: 1, waitMs: 1 },
      }),
      /state update was not written/,
    );
    assert.equal(readLock().ownerId, "live");

    fs.rmSync(lockPath, { recursive: true });
    writeLock({ pid: 2_147_483_647, hostname: os.hostname(), createdAtMs: 0, ownerId: "dead" });
    assert.equal(withFileLock(lockPath, () => "recovered", { timeoutMs: 50, staleMs: 1, waitMs: 1 }), "recovered");
    assert.ok(!fs.existsSync(lockPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function checkConcurrentMerge() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sheepdog-self-check-"));
  try {
    const worker = path.join(root, "worker.mjs");
    const statePath = path.join(root, "state.json");
    fs.writeFileSync(
      worker,
      `import { updateStateFile } from ${JSON.stringify(new URL("../extensions/sheepdog-state.ts", import.meta.url).pathname)};\nconst [statePath, scopeKey] = process.argv.slice(2);\nupdateStateFile(statePath, (state) => { state.entries[scopeKey] = { scopeGlob: scopeKey, status: "pending", origin: "auto", wakeAt: new Date().toISOString(), delayMs: 1, redactedExcerpt: scopeKey, source: "agent_end", cwd: process.cwd(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; });\n`,
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

if (mode === "detection") {
  checkDetection();
  console.log("self-check: detection ok");
} else if (mode === "time") {
  checkTimeFormatting();
  console.log("self-check: time ok");
} else if (mode === "mapper") {
  checkMapperConfig();
  console.log("self-check: mapper ok");
} else if (mode === "state") {
  checkStateSemantics();
  checkLockRecovery();
  await checkConcurrentMerge();
  console.log("self-check: state ok");
} else if (mode === "redaction") {
  checkRedaction();
  console.log("self-check: redaction ok");
} else {
  console.error(`unknown self-check mode: ${mode || "(missing)"}`);
  process.exit(1);
}
