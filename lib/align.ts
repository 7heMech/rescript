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
 * 3. `snapWordsToSpeech` then nudges remaining starts onto nearby onsets.
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
  /** Media duration; times are clamped to it when > 0. */
  duration?: number;
  /**
   * Mono PCM at `sampleRate`. When supplied, the global shift is estimated from
   * loudness rises rather than the VAD mask, which is the only thing that works on
   * speech with no pauses. Strongly recommended.
   */
  audio?: Float32Array;
  /**
   * Speech onsets to anchor and snap to, already refined against the audio. When
   * omitted they are derived from `speechFrames` unrefined. `alignWordsToSpeech`
   * sets this so the envelope is built once rather than per helper.
   */
  onsets?: number[];
}

/** Hop between envelope frames, in seconds. 5 ms is well under the error we chase. */
export const ENVELOPE_HOP_S = 0.005;

/** High-pass corner and order used to isolate fricative energy. */
const HIGH_BAND_HZ = 2000;
const HIGH_BAND_STAGES = 3;

/**
 * Loudness of the audio, sampled every `ENVELOPE_HOP_S`.
 *
 * `level` is the max of a broadband and a high-band envelope, each normalised
 * against its own 95th percentile. The high band matters: an unvoiced fricative
 * (/ʃ/, /s/, /f/) carries almost all its energy above 3 kHz and is far quieter
 * than a vowel, so a broadband envelope puts the onset of "shot" on the vowel
 * rather than on the /ʃ/ — about 0.2 s late. Taking the max of two separately
 * normalised bands lets either one mark an onset.
 */
export interface SpeechEnvelope {
  hopS: number;
  /** Normalised loudness, roughly 0..1. */
  level: Float32Array;
  /** Half-wave-rectified rise of `level`; word onsets land on peaks here. */
  rise: Float32Array;
  /** Noise floor, taken as the 10th percentile of `level`. */
  floor: number;
}

/** Value at percentile `p` (0..1) of a copy of `values`. */
function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice();
  sorted.sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * Build a speech envelope from mono PCM in a single pass. The high-band filter
 * runs sample-by-sample against a small state array rather than materialising a
 * filtered copy, which would double peak memory on long files.
 */
export function speechEnvelope(
  audio: Float32Array,
  sampleRate = VAD_SAMPLE_RATE,
  hopS = ENVELOPE_HOP_S
): SpeechEnvelope {
  const hop = Math.max(1, Math.round(hopS * sampleRate));
  const n = Math.floor(audio.length / hop);
  const broad = new Float32Array(n);
  const high = new Float32Array(n);

  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * HIGH_BAND_HZ);
  const a = rc / (rc + dt);
  const prevIn = new Float64Array(HIGH_BAND_STAGES);
  const prevOut = new Float64Array(HIGH_BAND_STAGES);

  for (let f = 0; f < n; f++) {
    const start = f * hop;
    const end = Math.min(audio.length, start + hop);
    let sumBroad = 0;
    let sumHigh = 0;
    for (let i = start; i < end; i++) {
      const x = audio[i];
      sumBroad += x * x;
      let v: number = x;
      for (let s = 0; s < HIGH_BAND_STAGES; s++) {
        const y = a * (prevOut[s] + v - prevIn[s]);
        prevIn[s] = v;
        prevOut[s] = y;
        v = y;
      }
      sumHigh += v * v;
    }
    const count = Math.max(1, end - start);
    broad[f] = Math.sqrt(sumBroad / count);
    high[f] = Math.sqrt(sumHigh / count);
  }

  // Normalise each band against its own loud level, so a quiet fricative can
  // still register as strongly as a vowel.
  const normBroad = percentile(broad, 0.95) || 1;
  const normHigh = percentile(high, 0.95) || 1;
  const combined = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    combined[f] = Math.max(broad[f] / normBroad, high[f] / normHigh);
  }

  // ~25 ms smoothing, so single-frame noise does not read as an onset.
  const level = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(n - 1, f + 2); k++) {
      sum += combined[k];
      count++;
    }
    level[f] = sum / count;
  }

  const rise = new Float32Array(n);
  let peak = 0;
  for (let f = 1; f < n; f++) {
    const d = level[f] - level[f - 1];
    rise[f] = d > 0 ? d : 0;
    if (rise[f] > peak) peak = rise[f];
  }
  if (peak > 0) for (let f = 0; f < n; f++) rise[f] /= peak;

  return { hopS, level, rise, floor: percentile(level, 0.1) };
}

/**
 * The global shift (seconds) that best lands word starts on loudness rises.
 *
 * Unlike the VAD-mask score this needs no pauses at all: it votes with every word
 * in the transcript, so continuous speech — where Whisper emits words back to back
 * and the mask score goes flat — still yields a sharp estimate. Positive means the
 * transcript is late. Ties resolve toward the smallest correction.
 */
export function estimateLagFromEnvelope(
  words: Word[],
  env: SpeechEnvelope,
  { maxLagS = 0.6, lagStepS = 0.01 }: AlignOptions = {}
): number {
  const { hopS, rise } = env;
  if (words.length === 0 || rise.length === 0) return 0;
  // Tolerate a frame or two of jitter between a word boundary and its onset.
  const slack = Math.max(1, Math.round(0.01 / hopS));
  const scoreAt = (t: number) => {
    const c = Math.round(t / hopS);
    let best = 0;
    for (let i = c - slack; i <= c + slack; i++) {
      if (i >= 0 && i < rise.length && rise[i] > best) best = rise[i];
    }
    return best;
  };
  let bestLag = 0;
  let bestScore = -1;
  for (const lag of lagCandidates(maxLagS, lagStepS)) {
    let score = 0;
    for (const w of words) score += scoreAt(w.start - lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return bestScore > 0 ? bestLag : 0;
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

/** How far back an onset may be dragged to find the true start of the sound. */
const MAX_ONSET_REFINE_S = 0.35;

/**
 * Refined onsets closer together than this describe one sound, not two.
 *
 * Silero often splits a fricative-initial word into two runs — on the test clip
 * "shot" gives one run for the /ʃ/ and another for the vowel 0.08 s later. Both
 * refine to real onsets, and anchor matching then picks the *later* one, putting
 * the word on its vowel again. Keeping only the earliest of a cluster fixes that.
 * Well below the ~0.2 s spacing of genuinely distinct syllables.
 */
const MIN_ONSET_SEPARATION_S = 0.15;

/**
 * Pull each VAD onset back to where the sound actually starts.
 *
 * Silero fires on voicing, so a word beginning with an unvoiced fricative gets an
 * onset on the vowel: on the test clip "shot" was flagged at 8.128 s when its /ʃ/
 * begins at 7.92 s. Walking back through the envelope recovers the missing 0.2 s.
 *
 * The walk stops at the first real gap in the sound. If it reaches the look-back
 * limit without finding one there is no evidence of a distinct onset, so the VAD
 * time is kept — without that check two onsets on the test clip ran the full
 * look-back and annexed the previous word.
 *
 * An onset landing within `MIN_ONSET_SEPARATION_S` of the previous one describes
 * the same sound and is dropped. That covers Silero splitting a fricative-initial
 * word into two runs, and doubles as the monotonicity guard. The returned list is
 * therefore usually shorter than `onsets`.
 */
export function refineOnsets(
  onsets: number[],
  env: SpeechEnvelope,
  maxLookBackS = MAX_ONSET_REFINE_S
): number[] {
  const { hopS, level, floor } = env;
  if (level.length === 0) return onsets.slice();
  const maxGapFrames = Math.round(0.03 / hopS);
  const out: number[] = [];
  let prev = -Infinity;

  for (const onset of onsets) {
    const at = Math.round(onset / hopS);
    const lo = Math.max(0, at - Math.round(maxLookBackS / hopS));
    // Loudness just after the onset tells us what "present" means here.
    let loud = 0;
    for (let i = at; i < Math.min(level.length, at + Math.round(0.08 / hopS)); i++) {
      if (level[i] > loud) loud = level[i];
    }
    const threshold = Math.max(floor * 2.5, floor + 0.08 * (loud - floor));

    let k = at;
    let gap = 0;
    let foundGap = false;
    while (k > lo) {
      if (level[k - 1] >= threshold) {
        gap = 0;
      } else if (++gap > maxGapFrames) {
        foundGap = true;
        break;
      }
      k--;
    }
    while (k < at && level[k] < threshold) k++;

    const refined = foundGap ? k * hopS : onset;
    // Landing on the previous anchor means this is the same sound, not a new one.
    if (refined <= prev + MIN_ONSET_SEPARATION_S) continue;
    out.push(refined);
    prev = refined;
  }
  return out;
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
  const onsets = options.onsets ?? speechEdgesFromFrames(speechFrames, options).onsets;
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

  const onsets = options.onsets ?? speechEdgesFromFrames(speechFrames, options).onsets;
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
 * A multi-syllable word cannot really last this long or less; if Whisper says so,
 * its DTW collapsed the word and gave the time to a neighbour.
 */
const SLIVER_MAX_S = 0.1;

/** Rough syllable count: vowel groups, at least one. */
function syllableCount(text: string): number {
  const groups = text.toLowerCase().replace(/[^a-z]/g, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

/**
 * Re-split words that Whisper's DTW collapsed to a sliver.
 *
 * Distinct from everything else here: this is not a timing offset, it is time
 * mis-distributed *between* adjacent words. On the test clip "evening" came back
 * spanning 0.06 s while the "and" before it took 0.40 s and 0.34 s went to no word
 * at all, even though both ends of that region were correctly placed. Shifting
 * cannot fix that; only re-splitting can.
 *
 * The region runs from the over-long neighbour's start to the next word's start,
 * trimmed back to where the audio actually goes quiet, and is divided by syllable
 * count. That is a guess at relative duration — a real forced aligner would know —
 * so it only fires on spans too short to be anything but broken.
 */
export function repairCollapsedWords(
  words: Word[],
  env: SpeechEnvelope | null,
  options: AlignOptions = {}
): Word[] {
  const { minWordS = 0.02, duration = 0 } = options;
  const out = words.map((w) => ({ ...w }));

  for (let i = 0; i < out.length; i++) {
    const word = out[i];
    if (word.end - word.start > SLIVER_MAX_S) continue;
    if (syllableCount(word.text) < 2) continue; // "a", "I", "the" really are brief

    const next = out[i + 1];
    let regionEnd = next ? next.start : word.end;
    // Do not reclaim time the audio says is silent.
    if (env && env.level.length > 0) {
      const threshold = env.floor * 2.5;
      let k = Math.min(env.level.length - 1, Math.round(regionEnd / env.hopS));
      const floorFrame = Math.round(word.end / env.hopS);
      while (k > floorFrame && env.level[k] < threshold) k--;
      regionEnd = Math.max(word.end, k * env.hopS);
    }

    // Pull in the previous word only when it is touching and looks over-long.
    const prev = i > 0 ? out[i - 1] : undefined;
    const joined = prev && word.start - prev.end < 1e-6;
    const group = joined ? [prev, word] : [word];
    const regionStart = group[0].start;
    const room = regionEnd - regionStart;
    const held = group.reduce((s, w) => s + (w.end - w.start), 0);
    if (room <= held + minWordS) continue; // nothing unassigned to reclaim

    const weights = group.map((w) => syllableCount(w.text));
    const total = weights.reduce((s, w) => s + w, 0);
    let cursor = regionStart;
    group.forEach((w, k) => {
      w.start = cursor;
      cursor = k === group.length - 1 ? regionEnd : cursor + (room * weights[k]) / total;
      w.end = cursor;
    });
  }
  return normalizeWords(out, minWordS, duration);
}

/**
 * Correct Whisper's late word timestamps against the audio.
 *
 * Interpolates the correction between matched pause anchors so the decay across
 * the clip is tracked rather than averaged away, then snaps remaining starts onto
 * nearby onsets. Falls back to a single global shift when there are too few
 * anchors to describe a curve. Returns new Word objects; the input is untouched.
 */
export function alignWordsToSpeech(
  words: Word[],
  speechFrames: boolean[],
  options: AlignOptions = {}
): Word[] {
  if (words.length === 0) return [];
  const { audio, sampleRate = VAD_SAMPLE_RATE } = options;
  const edges = speechEdgesFromFrames(speechFrames, options);
  // With audio we can do two things the VAD flags alone cannot: estimate the
  // shift from loudness rises (the VAD-mask score goes flat on speech that never
  // pauses, and silently returns ~0), and pull each onset back off the vowel onto
  // the fricative that actually starts the word.
  const env = audio ? speechEnvelope(audio, sampleRate) : null;
  const resolved: AlignOptions = env
    ? { ...options, onsets: refineOnsets(edges.onsets, env) }
    : options;
  const lag = env
    ? estimateLagFromEnvelope(words, env, options)
    : estimateSpeechLag(words, speechFrames, options);
  const anchors = buildSpeechAnchors(words, speechFrames, lag, resolved);
  const usable = anchors.length >= MIN_ANCHORS ? anchors : [];
  const warped = words.map((w) => ({
    ...w,
    start: w.start - correctionAt(usable, lag, w.start),
    end: w.end - correctionAt(usable, lag, w.end),
  }));
  const snapped = snapWordsToSpeech(warped, speechFrames, resolved);
  return repairCollapsedWords(snapped, env, options);
}

/**
 * Fixed lead subtracted from every word at the end of the timing pipeline.
 *
 * This is a perceptual nudge, not a measured correction — against acoustic
 * ground truth it slightly *increases* absolute error. A highlight that lands a
 * touch early reads as in sync; one that lands a touch late reads as lagging,
 * and the two are not equally forgiving.
 *
 * It survived the move to CTC alignment: measurement removed the part of the old
 * lead that compensated for a late reference (Silero raises its speech flag
 * ~40 ms after speech starts), but not the asymmetry in how early and late read.
 * Words still came back reading a hair late once alignment was doing its job.
 *
 * Tuned by ear, so expect this number to move — the VAD-only pipeline used 80 ms.
 * It is applied uniformly, so raising it never breaks relative timing; it only
 * trades "reads late" for "reads early", and the tests bound it rather than pin
 * it for that reason.
 */
export const ALIGN_LEAD_S = 0.08;

/**
 * Shift every word earlier by `leadS`, uniformly.
 *
 * Applied last, after disfluency placeholders, for two reasons: a uniform shift
 * over the finished list preserves every relative gap (placeholders included),
 * and nothing downstream can snap the nudge back onto an onset the way it could
 * when this lived inside {@link alignWordsToSpeech}.
 *
 * Both edges move together — leading only the starts would stretch every word by
 * `leadS` and eventually overlap its neighbour.
 */
export function applyAlignLead(
  words: Word[],
  leadS = ALIGN_LEAD_S,
  options: AlignOptions = {}
): Word[] {
  const { minWordS = 0.02, duration = 0 } = options;
  const out = words.map((w) => ({ ...w }));
  if (leadS === 0 || out.length === 0) return out;
  for (const w of out) {
    w.start -= leadS;
    w.end -= leadS;
  }
  // Clamps starts back to 0 and keeps the ordering and minimum-length guards.
  return normalizeWords(out, minWordS, duration);
}
