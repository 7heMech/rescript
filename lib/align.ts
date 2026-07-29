/**
 * Word-timestamp refinement against voice activity.
 *
 * Whisper derives word timestamps by running DTW over the decoder's
 * cross-attention, and the result runs systematically late: on a 24 s test clip
 * the transcript trailed the audio by ~0.2 s from start to finish (speech /
 * silence agreement 61% as decoded, 78% once shifted back). The bias survives
 * every knob in the decode path — VAD slicing, the Whisper lead pad, chunk
 * length, decoder quantization — so it has to be corrected after decoding.
 *
 * We already know where speech is: the per-frame VAD flags computed to slice
 * the audio. Two passes over them:
 *
 * 1. `estimateSpeechLag` picks one global shift, the one that best lines the
 *    transcript's pause boundaries up with the VAD's. Self-calibrating, so there
 *    is no per-model magic constant to keep in sync with model choices.
 * 2. `snapWordsToSpeech` then nudges individual boundaries onto nearby VAD
 *    edges, bounded so word order and a minimum word length always hold.
 *
 * `alignWordsToSpeech` runs both. All three are pure and take the frame flags
 * directly so they can be tested without loading a model.
 */
import type { Word } from "./types";
import { VAD_FRAME_SIZE, VAD_SAMPLE_RATE } from "./vad";

export interface AlignOptions {
  frameSize?: number;
  sampleRate?: number;
  /** Widest correction considered, searched in both directions. Default 0.6. */
  maxLagS?: number;
  /** Lag search granularity in seconds. Default 0.01. */
  lagStepS?: number;
  /** How far one boundary may move to land on a VAD edge. Default 0.2. */
  maxSnapS?: number;
  /**
   * A word boundary counts as a pause landmark when the neighbouring word is at
   * least this far away. Default 0.06 — Whisper emits words back to back, so any
   * gap at all marks a real pause.
   */
  minGapS?: number;
  /** How far a landmark may sit from a VAD edge and still be considered a match. Default 0.3. */
  landmarkTolS?: number;
  /** Words are never shortened below this. Default 0.02. */
  minWordS?: number;
  /** Media duration; times are clamped to it when > 0. */
  duration?: number;
}

/** Times (seconds) where speech runs begin and end in the VAD flags. */
export interface SpeechEdges {
  onsets: number[];
  offsets: number[];
}

/**
 * Rising / falling edges of the VAD flags, in seconds.
 *
 * A frame flag covers `[i * frameS, (i + 1) * frameS)`, so an onset is reported
 * at the leading edge of the first speech frame and an offset at the leading
 * edge of the first silent frame after it.
 */
export function speechEdgesFromFrames(
  speechFrames: boolean[],
  { frameSize = VAD_FRAME_SIZE, sampleRate = VAD_SAMPLE_RATE }: AlignOptions = {}
): SpeechEdges {
  const frameS = frameSize / sampleRate;
  const onsets: number[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < speechFrames.length; i++) {
    const on = speechFrames[i];
    const wasOn = i > 0 && speechFrames[i - 1];
    if (on && !wasOn) onsets.push(i * frameS);
    else if (!on && wasOn) offsets.push(i * frameS);
  }
  // Speech running to the very last frame ends with the audio.
  if (speechFrames.length > 0 && speechFrames[speechFrames.length - 1]) {
    offsets.push(speechFrames.length * frameS);
  }
  return { onsets, offsets };
}

/**
 * How many frames the transcript and the VAD agree about, for one candidate
 * shift. `lag` is how late the transcript is believed to be, so the words are
 * tested at `start - lag`. Only frames inside the transcript's own span (plus
 * the search margin) are scored: audio the model never transcribed would
 * otherwise contribute a constant mismatch that just dilutes the signal.
 */
function agreementAtLag(
  words: Word[],
  speechFrames: boolean[],
  lag: number,
  frameS: number,
  loFrame: number,
  hiFrame: number
): number {
  const spoken = new Uint8Array(hiFrame - loFrame);
  for (const w of words) {
    const a = Math.max(loFrame, Math.round((w.start - lag) / frameS));
    const b = Math.min(hiFrame, Math.round((w.end - lag) / frameS));
    for (let i = a; i < b; i++) spoken[i - loFrame] = 1;
  }
  let agree = 0;
  for (let i = loFrame; i < hiFrame; i++) {
    if (!!spoken[i - loFrame] === !!speechFrames[i]) agree++;
  }
  return agree;
}

/**
 * Word boundaries that sit next to a pause. Whisper emits words back to back
 * inside a phrase, so these are the only boundaries a VAD edge can confirm —
 * and the only ones a viewer notices, since they are where a word chip visibly
 * hangs over silence.
 */
function pauseLandmarks(words: Word[], minGapS: number): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  words.forEach((w, i) => {
    if (i === 0 || w.start - words[i - 1].end >= minGapS) starts.push(w.start);
    if (i === words.length - 1 || words[i + 1].start - w.end >= minGapS) ends.push(w.end);
  });
  return { starts, ends };
}

/**
 * How well the transcript's pause landmarks line up with the VAD's edges at one
 * candidate shift. Each landmark within `tol` of an edge contributes a linearly
 * decaying vote, so the objective peaks sharply instead of plateauing the way a
 * mask-overlap score does.
 */
function landmarkScoreAtLag(
  landmarks: { starts: number[]; ends: number[] },
  edges: SpeechEdges,
  lag: number,
  tol: number
): number {
  let score = 0;
  const vote = (times: number[], candidates: number[]) => {
    for (const t of times) {
      let bestDist = Infinity;
      for (const c of candidates) bestDist = Math.min(bestDist, Math.abs(t - lag - c));
      if (bestDist < tol) score += 1 - bestDist / tol;
    }
  };
  vote(landmarks.starts, edges.onsets);
  vote(landmarks.ends, edges.offsets);
  return score;
}

/** Candidate shifts, ordered outward from 0 so the smallest wins any tie. */
function lagCandidates(maxLagS: number, lagStepS: number): number[] {
  const steps = Math.floor(maxLagS / lagStepS);
  const out = [0];
  for (let k = 1; k <= steps; k++) out.push(k * lagStepS, -k * lagStepS);
  return out;
}

/** Below this many pause landmarks, the vote is noise — use mask overlap instead. */
const MIN_LANDMARKS = 4;

/**
 * The global shift (seconds) by which the transcript trails the audio.
 *
 * Positive means late — subtract it from every timestamp. Returns 0 when there
 * is nothing to measure against (no words, or VAD that found no speech at all),
 * which makes the correction a no-op on the full-audio fallback path. Ties
 * resolve toward the smallest correction.
 *
 * Prefers pause landmarks. Falls back to whole-mask overlap for clips with too
 * few pauses to vote on — that score is a biased estimator of shift whenever the
 * two masks disagree about how much of the clip is speech (Silero bridges short
 * inter-word pauses that the transcript splits), and on real audio its optimum
 * sat on a flat plateau, so it is the fallback rather than the default.
 */
export function estimateSpeechLag(
  words: Word[],
  speechFrames: boolean[],
  options: AlignOptions = {}
): number {
  const {
    frameSize = VAD_FRAME_SIZE,
    sampleRate = VAD_SAMPLE_RATE,
    maxLagS = 0.6,
    lagStepS = 0.01,
    minGapS = 0.06,
    landmarkTolS = 0.3,
  } = options;
  if (words.length === 0 || speechFrames.length === 0) return 0;
  if (!speechFrames.includes(true) || !speechFrames.includes(false)) return 0;

  const candidates = lagCandidates(maxLagS, lagStepS);
  const pickBest = (score: (lag: number) => number) => {
    let bestLag = 0;
    let bestScore = -Infinity;
    for (const lag of candidates) {
      const s = score(lag);
      if (s > bestScore) {
        bestScore = s;
        bestLag = lag;
      }
    }
    return { bestLag, bestScore };
  };

  const edges = speechEdgesFromFrames(speechFrames, options);
  const landmarks = pauseLandmarks(words, minGapS);
  if (landmarks.starts.length + landmarks.ends.length >= MIN_LANDMARKS) {
    const { bestLag, bestScore } = pickBest((lag) =>
      landmarkScoreAtLag(landmarks, edges, lag, landmarkTolS)
    );
    if (bestScore > 0) return bestLag;
  }

  const frameS = frameSize / sampleRate;
  const first = Math.min(...words.map((w) => w.start));
  const last = Math.max(...words.map((w) => w.end));
  const loFrame = Math.max(0, Math.floor((first - maxLagS) / frameS));
  const hiFrame = Math.min(speechFrames.length, Math.ceil((last + maxLagS) / frameS));
  if (hiFrame - loFrame < 2) return 0;
  return pickBest((lag) =>
    agreementAtLag(words, speechFrames, lag, frameS, loFrame, hiFrame)
  ).bestLag;
}

/** Nearest value in `sorted` to `target`, within `maxDist` and inside [lo, hi]. */
function nearestEdge(
  sorted: number[],
  target: number,
  maxDist: number,
  lo: number,
  hi: number
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const v of sorted) {
    if (v < target - maxDist) continue;
    if (v > target + maxDist) break; // sorted ascending
    if (v < lo || v > hi) continue;
    const d = Math.abs(v - target);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

/**
 * Move word boundaries onto nearby VAD edges without reordering the transcript.
 *
 * Each start may only move to an onset that sits after the previous word's
 * (already snapped) end, and each end only to an offset before the next word's
 * start — so a boundary can never jump across a neighbour and claim its audio.
 * Words the VAD has nothing to say about are left exactly where they were.
 */
export function snapWordsToSpeech(
  words: Word[],
  speechFrames: boolean[],
  options: AlignOptions = {}
): Word[] {
  const { maxSnapS = 0.2, minWordS = 0.02, duration = 0 } = options;
  const out = words.map((w) => ({ ...w }));
  if (out.length === 0) return out;

  const { onsets, offsets } = speechEdgesFromFrames(speechFrames, options);
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    const prevEnd = i > 0 ? out[i - 1].end : 0;
    const nextStart = i + 1 < out.length ? out[i + 1].start : Infinity;
    const onset = nearestEdge(onsets, w.start, maxSnapS, prevEnd, w.end);
    if (onset !== null) w.start = onset;
    const offset = nearestEdge(offsets, w.end, maxSnapS, w.start, nextStart);
    if (offset !== null) w.end = offset;
  }

  // Keep starts non-decreasing and every word at least minWordS long. The
  // minimum is applied after the duration clamp, matching the worker's own
  // guarantee that end is always strictly greater than start.
  const maxT = duration > 0 ? duration : Infinity;
  let prevStart = 0;
  for (const w of out) {
    w.start = Math.min(Math.max(w.start, prevStart, 0), maxT);
    w.end = Math.max(Math.min(w.end, maxT), w.start + minWordS);
    prevStart = w.start;
  }
  return out;
}

/**
 * Correct Whisper's late-biased word timestamps against the VAD flags: one
 * global shift, then per-boundary snapping. Returns new Word objects; the
 * input is untouched.
 */
export function alignWordsToSpeech(
  words: Word[],
  speechFrames: boolean[],
  options: AlignOptions = {}
): Word[] {
  const lag = estimateSpeechLag(words, speechFrames, options);
  const shifted =
    lag === 0
      ? words
      : words.map((w) => ({ ...w, start: w.start - lag, end: w.end - lag }));
  return snapWordsToSpeech(shifted, speechFrames, options);
}
