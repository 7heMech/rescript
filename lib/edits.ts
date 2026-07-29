import type {
  ClipSegment,
  CutAdjustments,
  CutRange,
  ManualCut,
  SceneBoundary,
  TimeRange,
  Word,
} from "./types";

/** Padding (s) applied when merging adjacent deleted words into one cut. */
const MERGE_GAP = 0.35;

/** Minimum kept clip length after a trim (seconds). */
export const MIN_CLIP_DURATION = 0.05;

/** Ignore splits this close to an existing edge (seconds). */
export const SPLIT_EPSILON = 0.04;

/** Smallest cut a cut-edge drag may leave, so edges never invert. */
export const MIN_CUT_DURATION = 0.03;

/**
 * Compute cut ranges from deleted words only (silence between adjacent
 * deleted words is included). Each cut is keyed by the first deleted word's id
 * so edge overrides can stay attached as the transcript changes.
 */
export function getWordCutRanges(words: Word[], duration: number): CutRange[] {
  const ranges: CutRange[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.deleted) continue;
    const key = w.id;
    const start = w.start;
    let end = w.end;
    while (i + 1 < words.length && words[i + 1].deleted) {
      i++;
      end = Math.max(end, words[i].end);
    }
    ranges.push({ start, end, key });
  }
  return mergeKeyedCutRanges(ranges, duration);
}

/** Merge overlapping / near-adjacent ranges and clamp to [0, duration]. */
export function mergeCutRanges(ranges: TimeRange[], duration: number): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges]
    .map((r) => ({
      start: Math.max(0, Math.min(duration, r.start)),
      end: Math.max(0, Math.min(duration, r.end)),
    }))
    .filter((r) => r.end - r.start > 1e-4)
    .sort((a, b) => a.start - b.start);

  const merged: TimeRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < MERGE_GAP) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Like mergeCutRanges, but preserves the earlier cut's key when merging. */
export function mergeKeyedCutRanges(ranges: CutRange[], duration: number): CutRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges]
    .map((r) => ({
      start: Math.max(0, Math.min(duration, r.start)),
      end: Math.max(0, Math.min(duration, r.end)),
      key: r.key,
    }))
    .filter((r) => r.end - r.start > 1e-4)
    .sort((a, b) => a.start - b.start);

  const merged: CutRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < MERGE_GAP) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Apply manual cut-edge overrides on top of word-derived cuts. An override
 * replaces either edge with an absolute time; unset edges keep tracking the
 * word boundary. Result is re-sorted and made non-overlapping.
 */
export function applyCutAdjustments(
  cuts: CutRange[],
  adjustments: CutAdjustments,
  duration: number
): CutRange[] {
  if (!adjustments || Object.keys(adjustments).length === 0) {
    return cuts.map((c) => ({ ...c }));
  }
  const clamp = (t: number) => Math.min(Math.max(0, t), duration);
  const adjusted = cuts.map((c) => {
    const a = adjustments[c.key];
    if (!a) return { ...c };
    const start = clamp(a.start ?? c.start);
    let end = clamp(a.end ?? c.end);
    if (end < start) end = start;
    return { ...c, start, end };
  });
  adjusted.sort((a, b) => a.start - b.start);
  for (let i = 1; i < adjusted.length; i++) {
    if (adjusted[i].start < adjusted[i - 1].end) {
      adjusted[i].start = adjusted[i - 1].end;
    }
    if (adjusted[i].end < adjusted[i].start) {
      adjusted[i].end = adjusted[i].start;
    }
  }
  return adjusted;
}

/** Word-derived cuts with edge overrides applied (for cut-handle UI). */
export function getAdjustedWordCuts(
  words: Word[],
  duration: number,
  adjustments: CutAdjustments = {}
): CutRange[] {
  return applyCutAdjustments(getWordCutRanges(words, duration), adjustments, duration);
}

/**
 * All cut ranges: (deleted-word spans ± edge overrides) ∪ manual blade/trim cuts.
 * Manual cuts may be passed as bare TimeRanges or ManualCut objects.
 */
export function getCutRanges(
  words: Word[],
  duration: number,
  manualCuts: Array<TimeRange | ManualCut> = [],
  cutAdjustments: CutAdjustments = {}
): TimeRange[] {
  const fromWords = getAdjustedWordCuts(words, duration, cutAdjustments);
  const fromManual = manualCuts.map((c) => ({ start: c.start, end: c.end }));
  return mergeCutRanges([...fromWords, ...fromManual], duration);
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

/**
 * Subdivide keep ranges by scene boundaries into selectable clip segments.
 * Boundaries that fall inside a cut are ignored for geometry.
 */
export function getClipSegments(
  keepRanges: TimeRange[],
  sceneBoundaries: SceneBoundary[]
): ClipSegment[] {
  const times = sceneBoundaries
    .map((b) => b.time)
    .sort((a, b) => a - b);

  const clips: ClipSegment[] = [];
  for (const keep of keepRanges) {
    const splits = times.filter(
      (t) => t > keep.start + SPLIT_EPSILON && t < keep.end - SPLIT_EPSILON
    );
    let cursor = keep.start;
    for (const t of splits) {
      clips.push({
        id: `c-${cursor.toFixed(4)}-${t.toFixed(4)}`,
        start: cursor,
        end: t,
        index: clips.length,
      });
      cursor = t;
    }
    clips.push({
      id: `c-${cursor.toFixed(4)}-${keep.end.toFixed(4)}`,
      start: cursor,
      end: keep.end,
      index: clips.length,
    });
  }
  return clips;
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

/**
 * Whether a word is fully removed from the edited media: either explicitly
 * deleted, or entirely covered by an effective cut (manual trim / adjustment).
 */
export function isWordCutOut(word: Word, cuts: TimeRange[]): boolean {
  if (word.deleted) return true;
  if (word.end - word.start <= 1e-4) return false;
  for (const c of cuts) {
    if (word.start >= c.start - 1e-4 && word.end <= c.end + 1e-4) return true;
  }
  return false;
}

/** Mark words whose full span lies inside [from, to) as deleted. */
export function deleteWordsCoveredBy(
  words: Word[],
  from: number,
  to: number
): Word[] {
  if (to <= from) return words;
  let changed = false;
  const next = words.map((w) => {
    if (w.deleted) return w;
    if (w.start >= from - 1e-4 && w.end <= to + 1e-4) {
      changed = true;
      return { ...w, deleted: true };
    }
    return w;
  });
  return changed ? next : words;
}

/** Restore deleted words whose full span lies inside [from, to). */
export function restoreWordsCoveredBy(
  words: Word[],
  from: number,
  to: number
): Word[] {
  if (to <= from) return words;
  let changed = false;
  const next = words.map((w) => {
    if (!w.deleted) return w;
    if (w.start >= from - 1e-4 && w.end <= to + 1e-4) {
      changed = true;
      return { ...w, deleted: false };
    }
    return w;
  });
  return changed ? next : words;
}

/** Find the clip containing time t, if any. */
export function clipAt(t: number, clips: ClipSegment[]): ClipSegment | null {
  for (const c of clips) {
    if (t >= c.start && t < c.end) return c;
    // Include exact end of last clip / exact start
    if (t === c.end && Math.abs(c.end - c.start) > 0) {
      // Prefer matching start of next; fall through
    }
  }
  // Exact end of media: last clip
  for (let i = clips.length - 1; i >= 0; i--) {
    if (t === clips[i].end) return clips[i];
  }
  return null;
}

/**
 * Whether a split is allowed at time t (inside a keep region, not too close
 * to existing edges or scene boundaries).
 */
export function canSplitAt(
  t: number,
  duration: number,
  cuts: TimeRange[],
  sceneBoundaries: SceneBoundary[]
): boolean {
  if (t <= SPLIT_EPSILON || t >= duration - SPLIT_EPSILON) return false;
  if (cutRangeAt(t, cuts)) return false;
  for (const cut of cuts) {
    if (Math.abs(t - cut.start) < SPLIT_EPSILON || Math.abs(t - cut.end) < SPLIT_EPSILON) {
      return false;
    }
  }
  for (const b of sceneBoundaries) {
    if (Math.abs(t - b.time) < SPLIT_EPSILON) return false;
  }
  return true;
}

/**
 * Clamp a word's new bounds against neighbors.
 * Returns updated start/end; may steal time from adjacent words when expanding.
 */
export function clampWordBounds(
  words: Word[],
  index: number,
  nextStart: number,
  nextEnd: number,
  duration: number
): { start: number; end: number; neighborPatches: Array<{ index: number; start?: number; end?: number }> } {
  const w = words[index];
  const minDur = 0.02;
  let start = Math.max(0, Math.min(nextStart, nextEnd - minDur));
  let end = Math.min(duration, Math.max(nextEnd, start + minDur));

  const patches: Array<{ index: number; start?: number; end?: number }> = [];

  const prev = index > 0 ? words[index - 1] : null;
  const next = index < words.length - 1 ? words[index + 1] : null;

  // Hard floor: don't cross into previous word's start
  if (prev) {
    const floor = prev.start + minDur;
    if (start < floor) start = floor;
    // If we expand left into prev, shrink prev.end
    if (start < prev.end) {
      patches.push({ index: index - 1, end: start });
    }
  }

  if (next) {
    const ceil = next.end - minDur;
    if (end > ceil) end = ceil;
    if (end > next.start) {
      patches.push({ index: index + 1, start: end });
    }
  }

  if (end - start < minDur) {
    end = start + minDur;
  }

  // Re-apply if patches would make neighbor invalid — prefer keeping this word's intent
  void w;
  return { start, end, neighborPatches: patches };
}

/**
 * Apply word-bound drag: returns a new words array with the target (and
 * possibly neighbors) updated.
 */
export function applyWordBounds(
  words: Word[],
  wordId: number,
  nextStart: number,
  nextEnd: number,
  duration: number
): Word[] | null {
  const index = words.findIndex((w) => w.id === wordId);
  if (index < 0) return null;
  const { start, end, neighborPatches } = clampWordBounds(
    words,
    index,
    nextStart,
    nextEnd,
    duration
  );
  const cur = words[index];
  if (Math.abs(cur.start - start) < 1e-4 && Math.abs(cur.end - end) < 1e-4 && neighborPatches.length === 0) {
    return null;
  }
  const next = words.map((w) => ({ ...w }));
  next[index] = { ...next[index], start, end };
  for (const p of neighborPatches) {
    next[p.index] = {
      ...next[p.index],
      ...(p.start !== undefined ? { start: p.start } : {}),
      ...(p.end !== undefined ? { end: p.end } : {}),
    };
  }
  return next;
}

/**
 * Shrink or remove manual cuts overlapping [from, to).
 * When a cut is split into two remnants, `nextId` supplies fresh ids.
 */
export function shrinkManualCuts(
  manualCuts: ManualCut[],
  from: number,
  to: number,
  nextId = 1_000_000
): { cuts: ManualCut[]; nextId: number } {
  if (to <= from) return { cuts: manualCuts, nextId };
  const out: ManualCut[] = [];
  let id = nextId;
  for (const c of manualCuts) {
    if (c.end <= from || c.start >= to) {
      out.push(c);
      continue;
    }
    if (c.start >= from && c.end <= to) continue;
    if (c.start < from && c.end > to) {
      out.push({ ...c, end: from });
      out.push({ id: id++, start: to, end: c.end });
      continue;
    }
    if (c.start < from) {
      out.push({ ...c, end: from });
      continue;
    }
    if (c.end > to) {
      out.push({ ...c, start: to });
    }
  }
  return { cuts: out, nextId: id };
}

/** Add a manual cut and merge with existing ones that touch. */
export function addManualCut(
  manualCuts: ManualCut[],
  start: number,
  end: number,
  nextId: number
): { cuts: ManualCut[]; nextId: number } {
  if (end - start < 1e-4) return { cuts: manualCuts, nextId };
  const merged = mergeCutRanges(
    [...manualCuts.map((c) => ({ start: c.start, end: c.end })), { start, end }],
    Number.POSITIVE_INFINITY
  );
  // Rebuild with stable-ish ids: keep old ids when a merged range covers an old cut's midpoint
  let id = nextId;
  const cuts: ManualCut[] = merged.map((r) => {
    const existing = manualCuts.find(
      (c) => c.start >= r.start - 1e-4 && c.end <= r.end + 1e-4
    );
    if (existing) return { id: existing.id, start: r.start, end: r.end };
    return { id: id++, start: r.start, end: r.end };
  });
  return { cuts, nextId: id };
}

/**
 * Trim one edge of a clip. Shrinking adds a manual cut and marks fully covered
 * words deleted; expanding shrinks manual cuts and restores words fully
 * contained in the reclaimed span.
 */
export function trimClipEdgeResult(
  words: Word[],
  manualCuts: ManualCut[],
  clip: ClipSegment,
  edge: "in" | "out",
  rawTime: number,
  duration: number,
  nextCutId: number
): {
  words: Word[];
  manualCuts: ManualCut[];
  nextCutId: number;
} | null {
  let t = Math.max(0, Math.min(duration, rawTime));
  if (edge === "in") {
    t = Math.min(t, clip.end - MIN_CLIP_DURATION);
    t = Math.max(t, 0);
    if (Math.abs(t - clip.start) < 1e-4) return null;

    if (t > clip.start) {
      // Shrink: cut [clip.start, t)
      const { cuts, nextId } = addManualCut(manualCuts, clip.start, t, nextCutId);
      return {
        words: deleteWordsCoveredBy(words, clip.start, t),
        manualCuts: cuts,
        nextCutId: nextId,
      };
    }

    // Expand left: reclaim [t, clip.start)
    const shrunk = shrinkManualCuts(manualCuts, t, clip.start, nextCutId);
    return {
      words: restoreWordsCoveredBy(words, t, clip.start),
      manualCuts: shrunk.cuts,
      nextCutId: shrunk.nextId,
    };
  }

  // out edge
  t = Math.max(t, clip.start + MIN_CLIP_DURATION);
  t = Math.min(t, duration);
  if (Math.abs(t - clip.end) < 1e-4) return null;

  if (t < clip.end) {
    const { cuts, nextId } = addManualCut(manualCuts, t, clip.end, nextCutId);
    return {
      words: deleteWordsCoveredBy(words, t, clip.end),
      manualCuts: cuts,
      nextCutId: nextId,
    };
  }

  const shrunk = shrinkManualCuts(manualCuts, clip.end, t, nextCutId);
  return {
    words: restoreWordsCoveredBy(words, clip.end, t),
    manualCuts: shrunk.cuts,
    nextCutId: shrunk.nextId,
  };
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
