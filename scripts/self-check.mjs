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
} else {
  console.error(`unknown self-check mode: ${mode || "(missing)"}`);
  process.exit(1);
}
