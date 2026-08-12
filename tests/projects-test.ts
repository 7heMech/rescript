import { formatRelativeTime } from "../lib/i18n";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const now = Date.parse("2026-07-27T12:00:00Z");

const justNow = formatRelativeTime("en", now - 10_000, now).toLowerCase();
assert(justNow.includes("now") || justNow.includes("second"), "just now");
assert(formatRelativeTime("en", now - 5 * 60_000, now).includes("5"), "minutes");
assert(formatRelativeTime("en", now - 3 * 3600_000, now).includes("3"), "hours");
assert(formatRelativeTime("en", now - 3 * 86400_000, now).includes("3"), "days");

console.log("ALL PROJECT HELPER TESTS PASSED");
