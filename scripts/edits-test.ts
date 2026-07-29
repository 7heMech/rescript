/**
 * Unit checks for flexible clip editing math (word bounds, splits, trims).
 * Run: npx tsx scripts/edits-test.ts
 */

import {
  applyCutAdjustments,
  applyWordBounds,
  canSplitAt,
  getAdjustedWordCuts,
  getClipSegments,
  getCutRanges,
  getKeepRanges,
  getWordCutRanges,
  trimClipEdgeResult,
} from "../lib/edits";
import type { CutAdjustments, ManualCut, SceneBoundary, Word } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function word(
  id: number,
  text: string,
  start: number,
  end: number,
  deleted = false
): Word {
  return { id, text, start, end, speaker: 0, deleted };
}

function nearly(a: number, b: number, eps = 1e-3) {
  return Math.abs(a - b) < eps;
}

// --- Word cuts include silence between adjacent deletes ---
{
  const words = [
    word(1, "hello", 0, 0.5),
    word(2, "uh", 0.6, 0.8, true),
    word(3, "everyone", 1.0, 1.5),
  ];
  const cuts = getWordCutRanges(words, 2);
  assert(cuts.length === 1, "one cut from uh");
  assert(nearly(cuts[0].start, 0.6) && nearly(cuts[0].end, 0.8), "uh span");
  assert(cuts[0].key === 2, "cut keyed by first deleted word id");
}

// --- Manual cuts merge with word cuts ---
{
  const words = [word(1, "a", 0, 1), word(2, "b", 1, 2, true), word(3, "c", 2, 3)];
  const manual: ManualCut[] = [{ id: 1, start: 2.5, end: 2.7 }];
  const cuts = getCutRanges(words, 3, manual);
  assert(cuts.length === 2, `expected 2 cuts, got ${cuts.length}`);
}

// --- Adjusting uh start away from hello ---
{
  const words = [
    word(1, "hello", 0.0, 0.55),
    word(2, "uh", 0.45, 0.7), // overlaps hello (ASR bleed)
    word(3, "everyone", 0.8, 1.2),
  ];
  const next = applyWordBounds(words, 2, 0.55, 0.7, 2);
  assert(next !== null, "bounds applied");
  assert(nearly(next![1].start, 0.55), "uh starts after hello");
  assert(nearly(next![0].end, 0.55), "hello end stolen/aligned");
}

// --- Split subdivides keep ranges ---
{
  const words = [word(1, "a", 0, 1), word(2, "b", 1, 2), word(3, "c", 2, 3)];
  const cuts = getCutRanges(words, 3, []);
  const keeps = getKeepRanges(cuts, 3);
  const boundaries: SceneBoundary[] = [{ id: 1, time: 1.5 }];
  const clips = getClipSegments(keeps, boundaries);
  assert(clips.length === 2, `expected 2 clips, got ${clips.length}`);
  assert(nearly(clips[0].end, 1.5) && nearly(clips[1].start, 1.5), "split at 1.5");
}

// --- canSplitAt rejects cuts ---
{
  const words = [word(1, "a", 0, 1, true), word(2, "b", 1, 2)];
  const cuts = getCutRanges(words, 2, []);
  assert(!canSplitAt(0.5, 2, cuts, []), "no split inside cut");
  assert(canSplitAt(1.5, 2, cuts, []), "split inside keep ok");
}

// --- Trim shrink adds manual cut ---
{
  const words = [word(1, "a", 0, 3)];
  const clip = { id: "c", start: 0, end: 3, index: 0 };
  const result = trimClipEdgeResult(words, [], clip, "in", 1, 3, 1);
  assert(result !== null, "trim ok");
  assert(result!.manualCuts.length === 1, "one manual cut");
  assert(
    nearly(result!.manualCuts[0].start, 0) && nearly(result!.manualCuts[0].end, 1),
    "cut [0,1)"
  );
}

// --- Cut edge adjustments override word bounds without changing words ---
{
  const words = [
    word(1, "hello", 0.0, 0.55),
    word(2, "uh", 0.45, 0.7, true), // overlaps hello (ASR bleed)
    word(3, "everyone", 0.8, 1.2),
  ];
  const base = getWordCutRanges(words, 2);
  assert(nearly(base[0].start, 0.45), "bleed into hello");
  const adjustments: CutAdjustments = { [base[0].key]: { start: 0.55 } };
  const adjusted = applyCutAdjustments(base, adjustments, 2);
  assert(nearly(adjusted[0].start, 0.55), "override pulls cut off hello");
  const effective = getCutRanges(words, 2, [], adjustments);
  assert(nearly(effective[0].start, 0.55), "getCutRanges applies overrides");
  const keyed = getAdjustedWordCuts(words, 2, adjustments);
  assert(keyed[0].key === 2, "adjusted cut keeps key");
}

// --- Adjustments compose with manual cuts ---
{
  const words = [word(1, "a", 0, 1), word(2, "b", 1, 2, true), word(3, "c", 2, 3)];
  const manual: ManualCut[] = [{ id: 1, start: 2.5, end: 2.7 }];
  const adjustments: CutAdjustments = { 2: { end: 1.8 } };
  const cuts = getCutRanges(words, 3, manual, adjustments);
  assert(cuts.length === 2, `expected 2 cuts, got ${cuts.length}`);
  assert(nearly(cuts[0].end, 1.8), "word cut end overridden");
  assert(nearly(cuts[1].start, 2.5), "manual cut intact");
}

console.log("edits-test: all passed");
