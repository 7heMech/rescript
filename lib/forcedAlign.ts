/**
 * CTC forced alignment.
 *
 * Whisper's word timestamps come from DTW over the decoder's cross-attention,
 * which is a by-product of decoding rather than a measurement: it runs late, the
 * error drifts across a clip, it puts fricative-initial words on their vowel, and
 * it sometimes collapses a word to a few milliseconds and hands its time to a
 * neighbour. `lib/align.ts` corrects each of those after the fact.
 *
 * This module removes the need for that. Given the transcript text and a CTC
 * acoustic model's per-frame character probabilities, Viterbi finds the single
 * most likely assignment of frames to characters. Word boundaries then fall out
 * of the path directly — measured against the audio rather than inferred from
 * attention, and correct by construction.
 *
 * Everything here is pure. The caller supplies the emission matrix, so the
 * algorithm is testable without loading a model.
 */
import type { Word } from "./types";
import type { SpeechEnvelope } from "./align";

/** Per-frame log-probabilities from a CTC model, row-major `[frames][vocab]`. */
export interface CtcEmission {
  logProbs: Float32Array;
  frames: number;
  vocab: number;
}

/** The pieces of a CTC tokenizer this module needs. */
export interface CtcVocab {
  /** Id of the CTC blank symbol (`<pad>` for wav2vec2). */
  blankId: number;
  /** Encode already-normalised text to token ids. */
  encode(text: string): number[];
  /** Id of the between-words symbol (`|`), if the vocab has one. */
  delimiterId?: number;
}

/**
 * Keep only what a character-level CTC vocabulary can represent. Digits and
 * punctuation have no acoustic spelling here, so a word made only of those
 * cannot be aligned and is interpolated from its neighbours instead.
 */
export function normalizeForCtc(text: string): string {
  return text.toUpperCase().replace(/[^A-Z']/g, "");
}

/** Which slice of the flattened token sequence belongs to which word. */
interface TokenSpan {
  /** Index into the caller's word array. */
  word: number;
  from: number;
  to: number;
}

interface TokenSequence {
  tokens: number[];
  spans: TokenSpan[];
}

/** Flatten words into one token sequence, separated by the delimiter symbol. */
function buildTokens(words: Word[], vocab: CtcVocab): TokenSequence {
  const tokens: number[] = [];
  const spans: TokenSpan[] = [];
  words.forEach((word, index) => {
    const ids = vocab.encode(normalizeForCtc(word.text));
    if (ids.length === 0) return;
    if (tokens.length > 0 && vocab.delimiterId !== undefined) {
      tokens.push(vocab.delimiterId);
    }
    const from = tokens.length;
    tokens.push(...ids);
    spans.push({ word: index, from, to: tokens.length });
  });
  return { tokens, spans };
}

/**
 * Viterbi over the standard CTC state lattice.
 *
 * The token sequence is expanded to `blank t0 blank t1 … blank` so a blank may
 * sit between any two tokens and *must* sit between two identical ones — which is
 * what makes doubled letters ("HELLO") align correctly. From each state a frame
 * may stay, advance one, or skip a blank to the next token when that token
 * differs from the previous one.
 *
 * Returns the state index chosen at each frame, or null when the audio is too
 * short to host every token.
 */
export function ctcViterbi(
  emission: CtcEmission,
  tokens: number[],
  blankId: number
): Int32Array | null {
  const { logProbs, frames, vocab } = emission;
  const n = tokens.length;
  if (n === 0 || frames === 0) return null;
  const states = 2 * n + 1;
  // CTC needs a frame per token, plus a blank between any repeated pair.
  let minimum = n;
  for (let i = 1; i < n; i++) if (tokens[i] === tokens[i - 1]) minimum++;
  if (frames < minimum) return null;

  const labelAt = (s: number) => (s % 2 === 1 ? tokens[(s - 1) / 2] : blankId);
  const NEG = -1e30;
  const score = new Float32Array(states).fill(NEG);
  const next = new Float32Array(states);
  // One backpointer per state per frame: 0 stay, 1 advance, 2 skip a blank.
  const back = new Uint8Array(frames * states);

  const lp = (t: number, v: number) => logProbs[t * vocab + v];
  score[0] = lp(0, blankId);
  if (states > 1) score[1] = lp(0, tokens[0]);

  for (let t = 1; t < frames; t++) {
    const row = t * states;
    for (let s = 0; s < states; s++) {
      let best = score[s];
      let choice = 0;
      if (s >= 1 && score[s - 1] > best) {
        best = score[s - 1];
        choice = 1;
      }
      // Skipping the blank at s-1 is only legal between two different tokens.
      if (s >= 2 && s % 2 === 1 && tokens[(s - 1) / 2] !== tokens[(s - 3) / 2] && score[s - 2] > best) {
        best = score[s - 2];
        choice = 2;
      }
      next[s] = best <= NEG ? NEG : best + lp(t, labelAt(s));
      back[row + s] = choice;
    }
    score.set(next);
  }

  // A valid path ends on the last token or the trailing blank.
  let state = score[states - 1] >= score[states - 2] ? states - 1 : states - 2;
  if (score[state] <= NEG) return null;

  const path = new Int32Array(frames);
  for (let t = frames - 1; t >= 0; t--) {
    path[t] = state;
    state -= back[t * states + state];
  }
  return path;
}

/**
 * Word timings from a Viterbi path.
 *
 * A word owns the frames whose state carries one of its tokens. Words with no
 * alignable characters keep a slot so the caller can interpolate them.
 */
function spansFromPath(
  path: Int32Array,
  spans: TokenSpan[],
  frameS: number,
  offsetS: number
): Map<number, { start: number; end: number }> {
  const first = new Int32Array(spans.length).fill(-1);
  const last = new Int32Array(spans.length).fill(-1);
  // token index -> span index
  const owner = new Map<number, number>();
  spans.forEach((span, i) => {
    for (let k = span.from; k < span.to; k++) owner.set(k, i);
  });

  for (let t = 0; t < path.length; t++) {
    const state = path[t];
    if (state % 2 === 0) continue; // blank
    const tokenIndex = (state - 1) / 2;
    const i = owner.get(tokenIndex);
    if (i === undefined) continue;
    if (first[i] < 0) first[i] = t;
    last[i] = t;
  }

  const out = new Map<number, { start: number; end: number }>();
  spans.forEach((span, i) => {
    if (first[i] < 0) return;
    out.set(span.word, {
      start: offsetS + first[i] * frameS,
      end: offsetS + (last[i] + 1) * frameS,
    });
  });
  return out;
}

/**
 * Align one batch of words against one slice of audio.
 *
 * `frameS` is derived from the emission length rather than assumed, so the
 * model's exact stride and any convolution edge effects are absorbed. Words the
 * vocabulary cannot spell are spread evenly through the gap their neighbours
 * leave. Returns null when the path cannot be found, so the caller can keep the
 * timings it already had.
 */
export function alignBatch(
  words: Word[],
  emission: CtcEmission,
  sliceStartS: number,
  sliceDurationS: number,
  vocab: CtcVocab
): Word[] | null {
  if (words.length === 0) return [];
  const { tokens, spans } = buildTokens(words, vocab);
  if (spans.length === 0) return null;

  const path = ctcViterbi(emission, tokens, vocab.blankId);
  if (!path) return null;

  const frameS = sliceDurationS / emission.frames;
  const timings = spansFromPath(path, spans, frameS, sliceStartS);
  if (timings.size === 0) return null;

  const out = words.map((w) => ({ ...w }));
  for (const [index, span] of timings) {
    out[index].start = span.start;
    out[index].end = span.end;
  }

  // Unalignable words (digits, bare punctuation) sit between aligned ones.
  for (let i = 0; i < out.length; i++) {
    if (timings.has(i)) continue;
    let j = i;
    while (j < out.length && !timings.has(j)) j++;
    const from = i > 0 ? out[i - 1].end : sliceStartS;
    const to = j < out.length ? out[j].start : sliceStartS + sliceDurationS;
    const step = (to - from) / (j - i);
    for (let k = i; k < j; k++) {
      out[k].start = from + step * (k - i);
      out[k].end = from + step * (k - i + 1);
    }
    i = j - 1;
  }
  return out;
}

/**
 * Widen CTC word spans out to the sound they cover.
 *
 * CTC emissions are peaky: the model fires a spike for each character and stays
 * blank around it, so the Viterbi path hands the frames at a word's edges to
 * blank and the span comes back too narrow — on the test clip "shot" started
 * 0.13 s and "evening" 0.16 s late. Growing each boundary through contiguous
 * sound recovers them.
 *
 * A boundary only ever grows into audio the envelope calls present, and never
 * past its neighbour, so a real pause between words is preserved and no word can
 * annexe another's audio. CTC has already decided *which* word owns a region;
 * this only sharpens where the edge falls.
 */
export function expandToAcoustics(
  words: Word[],
  env: SpeechEnvelope,
  maxGrowS = 0.3
): Word[] {
  const { hopS, level, floor } = env;
  const out = words.map((w) => ({ ...w }));
  if (level.length === 0) return out;
  const lastFrame = level.length - 1;
  const clampFrame = (f: number) => Math.min(lastFrame, Math.max(0, f));

  // What counts as present is set by how loud each word actually is.
  const thresholds = out.map((word) => {
    const at = clampFrame(Math.round(word.start / hopS));
    const endAt = clampFrame(Math.round(word.end / hopS));
    let loud = 0;
    for (let f = at; f <= endAt; f++) if (level[f] > loud) loud = level[f];
    return Math.max(floor * 2.5, floor + 0.08 * (loud - floor));
  });

  // Each side grows independently, against the neighbour's *decoded* boundary
  // rather than its grown one. Doing it sequentially would let whichever word is
  // processed first swallow the whole transition into the next.
  const decodedStart = out.map((w) => w.start);
  const decodedEnd = out.map((w) => w.end);
  const starts = out.map((word, i) => {
    const at = clampFrame(Math.round(word.start / hopS));
    const limit = clampFrame(
      Math.round(Math.max(i > 0 ? decodedEnd[i - 1] : 0, word.start - maxGrowS) / hopS)
    );
    let start = at;
    while (start > limit && level[start - 1] >= thresholds[i]) start--;
    return start * hopS;
  });
  const ends = out.map((word, i) => {
    const at = clampFrame(Math.round(word.end / hopS));
    const limit = clampFrame(
      Math.round(
        Math.min(
          i + 1 < out.length ? decodedStart[i + 1] : Infinity,
          word.end + maxGrowS
        ) / hopS
      )
    );
    let end = at;
    while (end < limit && level[end] >= thresholds[i]) end++;
    return end * hopS;
  });

  // Where both neighbours reached into the same sound there is no acoustic
  // evidence for the boundary — split the difference instead of picking a side.
  for (let i = 0; i + 1 < out.length; i++) {
    if (ends[i] > starts[i + 1]) {
      const middle = (ends[i] + starts[i + 1]) / 2;
      ends[i] = middle;
      starts[i + 1] = middle;
    }
  }

  for (let i = 0; i < out.length; i++) {
    out[i].start = starts[i];
    out[i].end = Math.max(ends[i], starts[i] + hopS);
  }
  return out;
}

/**
 * Split words into batches small enough to align in one pass.
 *
 * The Viterbi lattice is frames × tokens, so an unbroken hour would need
 * gigabytes. Batches are cut at the widest pause available, falling back to a
 * hard cut when speech runs longer than `maxSpanS` without one.
 */
export function groupWordsForAlignment(
  words: Word[],
  maxSpanS = 20,
  minGapS = 0.25
): Word[][] {
  const batches: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    if (current.length > 0) {
      const span = word.end - current[0].start;
      const gap = word.start - current[current.length - 1].end;
      if (span > maxSpanS && (gap >= minGapS || span > maxSpanS * 1.5)) {
        batches.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
