import {
  alignWordsToSpeech,
  estimateSpeechLag,
  snapWordsToSpeech,
  speechEdgesFromFrames,
} from "../lib/align";
import { VAD_FRAME_SIZE, VAD_SAMPLE_RATE } from "../lib/vad";
import type { Word } from "../lib/types";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const FRAME_S = VAD_FRAME_SIZE / VAD_SAMPLE_RATE; // 0.032

/** Speech flags from a list of [start, end) second ranges. */
function framesFor(ranges: Array<[number, number]>, totalS: number): boolean[] {
  const n = Math.ceil(totalS / FRAME_S);
  const frames = new Array<boolean>(n).fill(false);
  for (const [a, b] of ranges) {
    for (let i = Math.round(a / FRAME_S); i < Math.round(b / FRAME_S); i++) {
      if (i >= 0 && i < n) frames[i] = true;
    }
  }
  return frames;
}

function word(id: number, start: number, end: number): Word {
  return { id, text: `w${id}`, start, end, speaker: 0, deleted: false };
}

{
  const frames = framesFor(
    [
      [1, 2],
      [3, 4],
    ],
    5
  );
  const { onsets, offsets } = speechEdgesFromFrames(frames);
  assert(onsets.length === 2 && offsets.length === 2, "expected 2 onsets / 2 offsets");
  assert(Math.abs(onsets[0]! - 1) < FRAME_S, `onset 0 near 1s, got ${onsets[0]}`);
  assert(Math.abs(offsets[0]! - 2) < FRAME_S, `offset 0 near 2s, got ${offsets[0]}`);
  assert(Math.abs(onsets[1]! - 3) < FRAME_S, `onset 1 near 3s, got ${onsets[1]}`);
  console.log("speech edges: ok", { onsets, offsets });
}

{
  // Speech running to the last frame still yields a closing offset.
  const frames = framesFor([[0, 2]], 2);
  const { onsets, offsets } = speechEdgesFromFrames(frames);
  assert(onsets.length === 1 && offsets.length === 1, "trailing speech should close");
  assert(offsets[0]! >= 2 - FRAME_S, `closing offset near 2s, got ${offsets[0]}`);
  console.log("trailing speech closes: ok");
}

{
  // The core case: words uniformly 0.25s late over a 20s clip.
  const speech: Array<[number, number]> = [
    [2, 6],
    [6.5, 10],
    [11, 16],
    [16.4, 20],
  ];
  const frames = framesFor(speech, 22);
  const truth = speech.flatMap(([a, b]) => {
    const out: Word[] = [];
    for (let t = a; t + 0.4 <= b; t += 0.4) out.push(word(out.length, t, t + 0.4));
    return out;
  }).map((w, i) => ({ ...w, id: i }));
  const LATE = 0.25;
  const late = truth.map((w) => ({ ...w, start: w.start + LATE, end: w.end + LATE }));

  const lag = estimateSpeechLag(late, frames);
  assert(
    Math.abs(lag - LATE) <= FRAME_S,
    `expected lag ~${LATE}, got ${lag}`
  );

  const fixed = alignWordsToSpeech(late, frames, { duration: 22 });
  const errBefore =
    late.reduce((s, w, i) => s + Math.abs(w.start - truth[i]!.start), 0) / late.length;
  const errAfter =
    fixed.reduce((s, w, i) => s + Math.abs(w.start - truth[i]!.start), 0) / fixed.length;
  assert(errAfter < errBefore / 3, `alignment should cut error: ${errBefore} -> ${errAfter}`);
  console.log(
    `uniform lag corrected: ok (lag=${lag.toFixed(3)}s, mean start error ${errBefore.toFixed(3)}s -> ${errAfter.toFixed(3)}s)`
  );
}

{
  // Already aligned → leave it alone (no lag invented from noise).
  const frames = framesFor([[1, 3]], 4);
  const words = [word(0, 1, 1.5), word(1, 1.5, 2), word(2, 2, 3)];
  const lag = estimateSpeechLag(words, frames);
  assert(Math.abs(lag) <= 0.02, `aligned transcript should need no shift, got ${lag}`);
  console.log("already aligned is a no-op: ok");
}

{
  // Degenerate VAD input must never move anything.
  const words = [word(0, 1, 2), word(1, 2, 3)];
  for (const [label, frames] of [
    ["empty", [] as boolean[]],
    ["all speech", framesFor([[0, 4]], 4)],
    ["all silence", framesFor([], 4)],
  ] as const) {
    assert(estimateSpeechLag(words, frames) === 0, `${label} frames should give lag 0`);
    const out = alignWordsToSpeech(words, frames, { duration: 4 });
    assert(
      out.every((w, i) => w.start === words[i]!.start && w.end === words[i]!.end),
      `${label} frames should leave timings untouched`
    );
  }
  assert(alignWordsToSpeech([], framesFor([[1, 2]], 3)).length === 0, "empty words ok");
  console.log("degenerate inputs are no-ops: ok");
}

{
  // Snapping must not reorder words or let one swallow its neighbour's audio.
  const frames = framesFor(
    [
      [1, 1.5],
      [1.6, 2.2],
      [2.4, 3],
    ],
    4
  );
  const words = [word(0, 1.05, 1.55), word(1, 1.62, 2.18), word(2, 2.45, 2.95)];
  const out = snapWordsToSpeech(words, frames, { duration: 4, maxSnapS: 0.12 });
  for (let i = 0; i < out.length; i++) {
    assert(out[i]!.end > out[i]!.start, `word ${i} must have positive length`);
    if (i > 0) {
      assert(out[i]!.start >= out[i - 1]!.start, `starts must not go backwards at ${i}`);
    }
  }
  assert(out[0]!.start < out[1]!.start && out[1]!.start < out[2]!.start, "order preserved");
  console.log("snapping preserves order: ok", out.map((w) => [w.start, w.end]));
}

{
  // Clamps: nothing escapes [0, duration], and words keep a positive length.
  const frames = framesFor([[0, 1]], 2);
  const words = [word(0, -0.3, 0.2), word(1, 1.9, 5)];
  const out = snapWordsToSpeech(words, frames, { duration: 2 });
  assert(out[0]!.start >= 0, `start clamped to 0, got ${out[0]!.start}`);
  assert(out.every((w) => w.end > w.start), "every word keeps positive length");
  assert(out[1]!.end <= 2 + 0.02, `end clamped to duration, got ${out[1]!.end}`);
  console.log("clamping: ok", out.map((w) => [w.start, w.end]));
}

console.log("ALL ALIGN TESTS PASSED");
