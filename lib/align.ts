/**
 * Word-timestamp refinement against voice activity.
 *
 * Whisper derives word timestamps by running DTW over the decoder's
 * cross-attention, and the result runs late. The error is not a constant offset:
 * on a 24 s test clip (2 s of digital silence at each end, so both endpoints are
 * unambiguous ground truth) the transcript trailed the audio by 0.34 s at t=2 s
 * but only 0.01 s at t=22 s, decaying steeply over the first few seconds. A
 * single global shift therefore under-corrects the opening and over-corrects the
 * tail. The bias survives every knob in the decode path — VAD slicing, the
 * Whisper lead pad, chunk length, decoder quantization — so it has to be
 * corrected after decoding.
 *
 * We already know where speech is: the per-frame VAD flags computed to slice the
 * audio. So:
 *
 * 1. `buildSpeechAnchors` matches each pause-adjacent word start to a VAD speech
 *    onset, giving a list of (decoded time → observed time) pairs.
 * 2. `alignWordsToSpeech` interpolates the correction linearly between those
 *    anchors, holding it constant outside them, which tracks the decay instead of
 *    assuming it away. Guards keep the map strictly increasing.
 * 3. `snapWordsToSpeech` then nudges remaining starts onto nearby onsets, and a
 *    small fixed `ALIGN_LEAD_S` is applied so words land a hair early.
 *
 * Only *starts* are snapped, and only onsets are used as anchors. Silero holds a
 * speech flag for ~150 ms after speech actually stops, so anchoring word ends to
 * VAD offsets pushed the final word 0.16 s past the true end of the audio.
 *
 * `estimateSpeechLag` remains as the fallback for clips with too few pauses to
 * anchor. Everything here is pure and takes the frame flags directly, so it can
 * be tested without loading a model.
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
  /** How far a word start may move to land on a VAD onset. Default 0.08. */
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
  /**
   * Extra seconds subtracted from every timestamp after alignment, so words land
   * a hair early rather than a hair late. Default `ALIGN_LEAD_S`; set 0 to
   * measure raw alignment accuracy.
   */
  leadS?: number;
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

/**
 * One matched landmark: the decoded time of a word start, and the VAD onset it
 * belongs to. `from - to` is the correction to apply there.
 */
export interface SpeechAnchor {
  from: number;
  to: number;
}

/**
 * Slack in the monotonicity guard. Between consecutive anchors the correction may
 * change by at most this fraction of the interval, which keeps the warped time
 * map strictly increasing (its slope stays >= 1 - MAX_DRIFT_RATE > 0).
 */
const MAX_DRIFT_RATE = 0.9;

/** Anchors are only trusted to describe a curve once there are at least two. */
const MIN_ANCHORS = 2;

/**
 * Match pause-adjacent word starts to VAD speech onsets.
 *
 * `lag` is a rough prior used only to decide which onset a landmark belongs to,
 * so a late transcript still matches the right pause. The result is strictly
 * increasing in both coordinates and rate-limited, so interpolating between the
 * anchors can never reorder time.
 */
export function buildSpeechAnchors(
  words: Word[],
  speechFrames: boolean[],
  lag: number,
  options: AlignOptions = {}
): SpeechAnchor[] {
  const { minGapS = 0.06, landmarkTolS = 0.3 } = options;
  const { onsets } = speechEdgesFromFrames(speechFrames, options);
  if (onsets.length === 0) return [];

  const anchors: SpeechAnchor[] = [];
  words.forEach((w, i) => {
    if (i > 0 && w.start - words[i - 1].end < minGapS) return;
    let onset: number | null = null;
    let bestDist = Infinity;
    for (const o of onsets) {
      const d = Math.abs(w.start - lag - o);
      if (d < bestDist) {
        bestDist = d;
        onset = o;
      }
    }
    if (onset === null || bestDist > landmarkTolS) return;

    const prev = anchors[anchors.length - 1];
    if (!prev) {
      anchors.push({ from: w.start, to: onset });
      return;
    }
    // Strictly increasing in both coordinates, and rate-limited so the warp
    // built from these anchors cannot fold time back on itself.
    if (w.start <= prev.from || onset <= prev.to) return;
    const delta = Math.abs(w.start - onset - (prev.from - prev.to));
    if (delta > MAX_DRIFT_RATE * (w.start - prev.from)) return;
    anchors.push({ from: w.start, to: onset });
  });
  return anchors;
}

/**
 * The correction to subtract at time `t`: linear between anchors, constant
 * outside them. Extrapolating a slope past the last anchor overshot badly on
 * real audio (the tail landed 0.17 s late), so the ends are deliberately flat.
 */
export function correctionAt(anchors: SpeechAnchor[], fallbackLag: number, t: number): number {
  if (anchors.length === 0) return fallbackLag;
  const first = anchors[0];
  if (t <= first.from) return first.from - first.to;
  const last = anchors[anchors.length - 1];
  if (t >= last.from) return last.from - last.to;
  for (let k = 0; k + 1 < anchors.length; k++) {
    const a = anchors[k];
    const b = anchors[k + 1];
    if (t >= a.from && t <= b.from) {
      const da = a.from - a.to;
      const db = b.from - b.to;
      return da + ((db - da) * (t - a.from)) / (b.from - a.from);
    }
  }
  return fallbackLag;
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
 * Move word starts onto nearby VAD onsets without reordering the transcript.
 *
 * A start may only move to an onset that sits after the previous word's end and
 * before this word's own end, so a boundary can never jump across a neighbour and
 * claim its audio. Words the VAD has nothing to say about are left exactly where
 * they were. Ends are deliberately not snapped — see the file header.
 */
export function snapWordsToSpeech(
  words: Word[],
  speechFrames: boolean[],
  options: AlignOptions = {}
): Word[] {
  const { maxSnapS = 0.08, minWordS = 0.02, duration = 0 } = options;
  const out = words.map((w) => ({ ...w }));
  if (out.length === 0) return out;

  const { onsets } = speechEdgesFromFrames(speechFrames, options);
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    const prevEnd = i > 0 ? out[i - 1].end : 0;
    const onset = nearestEdge(onsets, w.start, maxSnapS, prevEnd, w.end);
    if (onset !== null) w.start = onset;
  }
  return normalizeWords(out, minWordS, duration);
}

/**
 * Keep starts non-decreasing and every word at least `minWordS` long, inside
 * [0, duration]. The minimum length is applied after the duration clamp, matching
 * the worker's own guarantee that end is always strictly greater than start.
 * Mutates and returns `words`.
 */
function normalizeWords(words: Word[], minWordS: number, duration: number): Word[] {
  const maxT = duration > 0 ? duration : Infinity;
  let prevStart = 0;
  for (const w of words) {
    w.start = Math.min(Math.max(w.start, prevStart, 0), maxT);
    w.end = Math.max(Math.min(w.end, maxT), w.start + minWordS);
    prevStart = w.start;
  }
  return words;
}

/**
 * Fixed extra lead applied after alignment, in seconds.
 *
 * Alignment can only ever be as good as its reference, and the reference is a
 * hair late in both directions: Silero raises its speech flag ~40 ms after speech
 * actually starts, and a highlight that lands a touch early reads as in sync
 * whereas one that lands late reads as lagging. This is a deliberate perceptual
 * nudge, not a measured correction — against acoustic ground truth it slightly
 * increases absolute error, so keep it small and change it here.
 */
export const ALIGN_LEAD_S = 0.08;

/**
 * Correct Whisper's late word timestamps against the VAD flags.
 *
 * Interpolates the correction between matched pause anchors so the decay across
 * the clip is tracked rather than averaged away, then snaps remaining starts onto
 * nearby onsets, then applies `leadS`. Falls back to a single global shift when
 * there are too few anchors to describe a curve. Returns new Word objects; the
 * input is untouched.
 */
export function alignWordsToSpeech(
  words: Word[],
  speechFrames: boolean[],
  options: AlignOptions = {}
): Word[] {
  if (words.length === 0) return [];
  const { leadS = ALIGN_LEAD_S, minWordS = 0.02, duration = 0 } = options;
  const lag = estimateSpeechLag(words, speechFrames, options);
  const anchors = buildSpeechAnchors(words, speechFrames, lag, options);
  const usable = anchors.length >= MIN_ANCHORS ? anchors : [];
  const warped = words.map((w) => ({
    ...w,
    start: w.start - correctionAt(usable, lag, w.start),
    end: w.end - correctionAt(usable, lag, w.end),
  }));
  const snapped = snapWordsToSpeech(warped, speechFrames, options);
  if (leadS === 0) return snapped;
  // After snapping, so the snap cannot pull the lead back onto the VAD onset.
  for (const w of snapped) {
    w.start -= leadS;
    w.end -= leadS;
  }
  return normalizeWords(snapped, minWordS, duration);
}
