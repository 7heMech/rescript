import {
  alignWordsToSpeech,
  buildSpeechAnchors,
  correctionAt,
  estimateLagFromEnvelope,
  estimateSpeechLag,
  speechEnvelope,
  snapWordsToSpeech,
  speechEdgesFromFrames,
  refineOnsets,
  repairCollapsedWords,
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
  // The case a single global shift cannot handle: lag that decays across the
  // clip (0.30 s at the start, 0.05 s at the end), as measured on real audio.
  const speech: Array<[number, number]> = [
    [2, 5],
    [5.6, 9],
    [9.7, 13],
    [13.6, 17],
    [17.6, 21],
  ];
  const frames = framesFor(speech, 23);
  const truth: Word[] = [];
  for (const [a, b] of speech) {
    for (let t = a; t + 0.4 <= b; t += 0.4) truth.push(word(truth.length, t, t + 0.4));
  }
  const lagAt = (t: number) => 0.3 - (0.25 * (t - 2)) / 19; // 0.30 at t=2 -> 0.05 at t=21
  const drifted = truth.map((w) => ({
    ...w,
    start: w.start + lagAt(w.start),
    end: w.end + lagAt(w.end),
  }));

  const anchors = buildSpeechAnchors(
    drifted,
    frames,
    estimateSpeechLag(drifted, frames)
  );
  assert(anchors.length >= 2, `expected multiple anchors, got ${anchors.length}`);
  // The interpolated correction must track the decay, not average it.
  const early = correctionAt(anchors, 0, 2.3);
  const late = correctionAt(anchors, 0, 20.5);
  assert(early > late + 0.1, `correction should decay: ${early} -> ${late}`);

  const fixed = alignWordsToSpeech(drifted, frames, { duration: 23 });
  const mae = (ws: Word[]) =>
    ws.reduce((s, w, i) => s + Math.abs(w.start - truth[i]!.start), 0) / ws.length;
  const flat = snapWordsToSpeech(
    drifted.map((w) => {
      const l = estimateSpeechLag(drifted, frames);
      return { ...w, start: w.start - l, end: w.end - l };
    }),
    frames,
    { duration: 23 }
  );
  assert(mae(fixed) < mae(flat), `warp ${mae(fixed)} should beat flat shift ${mae(flat)}`);
  assert(mae(fixed) < 0.05, `warp error should be small, got ${mae(fixed)}`);
  for (let i = 1; i < fixed.length; i++) {
    assert(fixed[i]!.start >= fixed[i - 1]!.start, `order broken at ${i}`);
    assert(fixed[i]!.end > fixed[i]!.start, `zero-length word at ${i}`);
  }
  console.log(
    `drifting lag tracked: ok (correction ${early.toFixed(3)}s -> ${late.toFixed(3)}s; ` +
      `mean start error flat ${mae(flat).toFixed(3)}s vs warp ${mae(fixed).toFixed(3)}s)`
  );
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

{
  // Continuous speech: Whisper emits words back to back, so there are no pause
  // landmarks and the VAD-mask score goes flat (a solid block of words inside a
  // solid block of speech trades one edge mismatch for the other). The loudness
  // envelope still votes with every word, so it stays sharp.
  const SR = VAD_SAMPLE_RATE;
  const TOTAL = 30;
  const truth: Word[] = [];
  for (let t = 1; t + 0.35 <= 29; t += 0.35) {
    truth.push(word(truth.length, t, t + 0.35));
  }
  // A decaying burst per word, so every onset sits at a known time.
  const audio = new Float32Array(Math.round(TOTAL * SR));
  for (const w of truth) {
    const s = Math.round(w.start * SR);
    const e = Math.min(audio.length, Math.round(w.end * SR));
    for (let i = s; i < e; i++) {
      audio[i] += Math.sin(i / 12) * 0.35 * Math.exp((-(i - s) / SR) * 6);
    }
  }
  const frames = framesFor([[1, 29]], TOTAL);

  for (const LAG of [0.1, 0.25, 0.34]) {
    const late = truth.map((w) => ({ ...w, start: w.start + LAG, end: w.end + LAG }));
    const fromEnv = estimateLagFromEnvelope(late, speechEnvelope(audio, SR));
    assert(
      Math.abs(fromEnv - LAG) <= 0.02,
      `envelope should recover lag ${LAG}, got ${fromEnv}`
    );
    // The VAD-only path is expected to miss this badly — that is why audio is passed.
    const vadOnly = alignWordsToSpeech(late, frames, { duration: TOTAL });
    const withAudio = alignWordsToSpeech(late, frames, {
      duration: TOTAL,
      audio,
      sampleRate: SR,
    });
    const mae = (ws: Word[]) =>
      ws.reduce((s, w, i) => s + Math.abs(w.start - truth[i]!.start), 0) / ws.length;
    assert(
      mae(withAudio) < 0.03,
      `audio-anchored alignment should be tight, got ${mae(withAudio)} for lag ${LAG}`
    );
    assert(
      mae(withAudio) < mae(vadOnly),
      `audio should beat VAD-only on pauseless speech (${mae(withAudio)} vs ${mae(vadOnly)})`
    );
    for (let i = 1; i < withAudio.length; i++) {
      assert(withAudio[i]!.start >= withAudio[i - 1]!.start, `order broken at ${i}`);
      assert(withAudio[i]!.end > withAudio[i]!.start, `zero-length word at ${i}`);
    }
  }
  // Silence in, nothing out: no rises means no estimate rather than a wrong one.
  assert(
    estimateLagFromEnvelope(truth, speechEnvelope(new Float32Array(SR * 5), SR)) === 0,
    "silent audio should yield no lag estimate"
  );
  console.log("pauseless speech corrected via loudness envelope: ok");
}

{
  // Unvoiced fricatives: Silero fires on voicing, so a word like "shot" gets its
  // VAD onset on the vowel and the /S/ in front of it is missed. Broadband RMS
  // makes the same mistake — the fricative is much quieter than the vowel — so the
  // envelope splits into a high band that can mark it.
  const SR = VAD_SAMPLE_RATE;
  const TOTAL = 3;
  const audio = new Float32Array(Math.round(TOTAL * SR));
  const FRIC_START = 1.0, VOWEL_START = 1.22, VOWEL_END = 1.6;
  // /S/: quiet, high frequency only.
  for (let i = Math.round(FRIC_START * SR); i < Math.round(VOWEL_START * SR); i++) {
    audio[i] = (Math.sin(i * 1.9) + Math.sin(i * 2.3)) * 0.03;
  }
  // vowel: loud, low frequency.
  for (let i = Math.round(VOWEL_START * SR); i < Math.round(VOWEL_END * SR); i++) {
    audio[i] = Math.sin(i / 40) * 0.3;
  }
  // VAD sees only the voiced part, exactly as Silero does.
  const frames = framesFor([[VOWEL_START, VOWEL_END]], TOTAL);
  const edges = speechEdgesFromFrames(frames);
  const env = speechEnvelope(audio, SR);
  const refined = refineOnsets(edges.onsets, env);
  assert(refined.length >= 1, "refinement keeps at least one onset");
  assert(
    Math.abs(refined[0]! - FRIC_START) < 0.05,
    `onset should move back to the fricative at ${FRIC_START}, got ${refined[0]} (VAD said ${edges.onsets[0]})`
  );


  // Silero often splits a fricative-initial word into two runs (one for the /S/,
  // one for the vowel). Both refine to real onsets, and anchor matching would then
  // pick the later one — putting the word back on its vowel. They must collapse.
  const split = framesFor(
    [
      [FRIC_START + 0.02, FRIC_START + 0.1],
      [VOWEL_START, VOWEL_END],
    ],
    TOTAL
  );
  const splitEdges = speechEdgesFromFrames(split);
  assert(splitEdges.onsets.length === 2, "fixture should give two VAD runs");
  const merged = refineOnsets(splitEdges.onsets, env);
  assert(
    merged.length === 1,
    `two runs of one sound should collapse to one onset, got ${merged.length}: ${merged}`
  );
  assert(
    Math.abs(merged[0]! - FRIC_START) < 0.05,
    `the surviving onset should be the earliest, got ${merged[0]}`
  );

  // No gap inside the look-back means no evidence of a distinct onset, so the VAD
  // time must be kept rather than dragged an arbitrary distance backwards.
  const solid = new Float32Array(Math.round(TOTAL * SR));
  for (let i = 0; i < solid.length; i++) solid[i] = Math.sin(i / 40) * 0.3;
  const solidEnv = speechEnvelope(solid, SR);
  const mid = 1.5;
  const kept = refineOnsets([mid], solidEnv);
  assert(
    kept.length === 1 && Math.abs(kept[0]! - mid) < 1e-9,
    `continuous sound should keep its VAD onset, got ${kept}`
  );

  // Results stay ordered whatever the input.
  const twoRuns = framesFor([[0.3, 0.7], [VOWEL_START, VOWEL_END]], TOTAL);
  const twoEdges = speechEdgesFromFrames(twoRuns);
  const bounded = refineOnsets(twoEdges.onsets, env);
  for (let i = 1; i < bounded.length; i++) {
    assert(bounded[i]! > bounded[i - 1]!, `refined onsets must stay ordered at ${i}`);
  }
  console.log(
    `fricative onset recovered: ok (VAD ${edges.onsets[0]!.toFixed(3)} -> ${refined[0]!.toFixed(3)}, true ${FRIC_START})`
  );
}

{
  // Time mis-distributed between neighbours, not shifted: Whisper gave "evening"
  // 0.06 s while "and" took 0.40 s and 0.34 s went to no word at all, with both
  // ends of the region correctly placed. Only re-splitting can fix that.
  const words = [
    word(0, 20.0, 20.4),   // "and" - over-long
    word(1, 20.4, 20.46),  // "evening" - collapsed to a sliver
    word(2, 20.8, 21.2),   // "bell" - correctly placed, must not move
  ];
  words[0]!.text = "and";
  words[1]!.text = "evening";
  words[2]!.text = "bell";
  const fixed = repairCollapsedWords(words, null, { duration: 24 });
  assert(
    fixed[1]!.end - fixed[1]!.start > 0.4,
    `collapsed word should regain real duration, got ${(fixed[1]!.end - fixed[1]!.start).toFixed(3)}s`
  );
  assert(fixed[2]!.start === 20.8, `the next word must not move, got ${fixed[2]!.start}`);
  assert(fixed[0]!.start === 20.0, `the region start must not move, got ${fixed[0]!.start}`);
  assert(
    fixed[0]!.end < words[0]!.end,
    "the over-long neighbour should give time back"
  );
  for (let i = 1; i < fixed.length; i++) {
    assert(fixed[i]!.start >= fixed[i - 1]!.start, `order broken at ${i}`);
    assert(fixed[i]!.end > fixed[i]!.start, `zero-length word at ${i}`);
  }

  // Single-syllable function words really can be brief - leave them alone.
  const brief = [word(0, 1.0, 1.4), word(1, 1.4, 1.44), word(2, 2.0, 2.4)];
  brief[1]!.text = "a";
  const untouched = repairCollapsedWords(brief, null, { duration: 5 });
  assert(
    untouched[1]!.start === 1.4 && untouched[1]!.end === 1.44,
    "a one-syllable word must not be re-split"
  );

  // Nothing unassigned to reclaim -> no change.
  const packed = [word(0, 1.0, 1.4), word(1, 1.4, 1.46), word(2, 1.46, 1.9)];
  packed[1]!.text = "evening";
  const same = repairCollapsedWords(packed, null, { duration: 5 });
  assert(
    same[1]!.end - same[1]!.start < 0.1,
    "with no spare room the word must be left as decoded"
  );
  console.log(
    `collapsed word re-split: ok (0.060s -> ${(fixed[1]!.end - fixed[1]!.start).toFixed(3)}s)`
  );
}

console.log("ALL ALIGN TESTS PASSED");
