import { formatRelativeTime } from "../lib/projects";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const now = Date.parse("2026-07-27T12:00:00Z");

assert(formatRelativeTime(now - 10_000, now) === "just now", "just now");
assert(formatRelativeTime(now - 5 * 60_000, now) === "5m ago", "minutes");
assert(formatRelativeTime(now - 3 * 3600_000, now) === "3h ago", "hours");
assert(formatRelativeTime(now - 3 * 86400_000, now) === "3d ago", "days");

console.log("ALL PROJECT HELPER TESTS PASSED");
