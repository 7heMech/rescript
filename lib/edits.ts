import type { TimeRange, Word } from "./types";

/** Padding (s) applied when merging adjacent deleted words into one cut. */
const MERGE_GAP = 0.35;

/**
 * Compute the ranges of the original media that have been cut, by merging
 * runs of consecutive deleted words. The silence between two adjacent deleted
 * words is cut too, so deleting a phrase removes it cleanly.
 */
export function getCutRanges(words: Word[], duration: number): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.deleted) continue;
    const start = w.start;
    let end = w.end;
    while (i + 1 < words.length && words[i + 1].deleted) {
      i++;
      end = Math.max(end, words[i].end);
    }
    ranges.push({ start, end });
  }
  // Merge ranges separated by less than MERGE_GAP to avoid audible slivers.
  const merged: TimeRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < MERGE_GAP) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged.map((r) => ({
    start: Math.max(0, r.start),
    end: Math.min(duration, r.end),
  }));
}

/** Invert cut ranges into the ranges of the original media that remain. */
export function getKeepRanges(cuts: TimeRange[], duration: number): TimeRange[] {
  const keeps: TimeRange[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor + 1e-4) keeps.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < duration - 1e-4) keeps.push({ start: cursor, end: duration });
  return keeps;
}

/** Duration of the edited video (sum of kept ranges). */
export function getEditedDuration(cuts: TimeRange[], duration: number): number {
  const cut = cuts.reduce((acc, r) => acc + (r.end - r.start), 0);
  return Math.max(0, duration - cut);
}

/** Map a time in original media to the corresponding time in the edited cut. */
export function originalToEdited(t: number, cuts: TimeRange[]): number {
  let removed = 0;
  for (const cut of cuts) {
    if (t >= cut.end) removed += cut.end - cut.start;
    else if (t > cut.start) removed += t - cut.start;
  }
  return Math.max(0, t - removed);
}

/** Find the cut range containing time t, if any. */
export function cutRangeAt(t: number, cuts: TimeRange[]): TimeRange | null {
  for (const cut of cuts) {
    if (t >= cut.start && t < cut.end) return cut;
  }
  return null;
}

/** Format seconds as m:ss.d (or h:mm:ss for long media). */
export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}`;
  }
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}
