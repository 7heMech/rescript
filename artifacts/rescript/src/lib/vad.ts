/**
 * Voice-activity helpers used to reduce Whisper hallucinations on long
 * silence / music stretches.
 *
 * Strategy: detect speech frames, merge short pauses, then return contiguous
 * speech segments. Callers run Whisper only on those slices and remap
 * timestamps back onto the original timeline — silent gaps are never decoded.
 */

export const VAD_SAMPLE_RATE = 16_000;
/** Silero VAD expects 512-sample frames at 16 kHz (~32 ms). */
export const VAD_FRAME_SIZE = 512;

export interface SpeechSegment {
  /** Inclusive start sample in the original audio. */
  startSample: number;
  /** Exclusive end sample in the original audio. */
  endSample: number;
}

export interface SpeechSegmentOptions {
  /**
   * Gaps of silence shorter than this (seconds) are kept inside a segment
   * (breaths, brief pauses). Longer gaps split segments. Default 1.5.
   */
  maxGapS?: number;
  /** Expand each speech region by this much (seconds) on each side. Default 0.25. */
  padS?: number;
  /** Drop segments shorter than this (seconds). Default 0.15. */
  minSpeechS?: number;
  /**
   * Longest segment handed to ASR, in seconds. Default {@link MAX_SEGMENT_S}.
   * Longer merged runs are split at their quietest interior point.
   */
  maxSegmentS?: number;
  frameSize?: number;
  sampleRate?: number;
}

/**
 * Longest speech segment produced, in seconds.
 *
 * `maxGapS` alone puts no ceiling on segment length: continuous speech with no
 * pause longer than 1.5 s — a lecture, a podcast, most talking-head video — is
 * one run from the first word to the last. The caller then copies that whole
 * span into a padded buffer before decoding it, which duplicates the entire
 * recording in memory (230 MB for an hour) and makes the ASR pipeline
 * accumulate its per-chunk state across the entire file in a single call.
 *
 * Two minutes is far longer than the 29 s window the ASR pipeline chunks to
 * internally, so splitting here costs no decoding context that the pipeline was
 * keeping anyway, and it bounds the copy at ~4 MB.
 */
export const MAX_SEGMENT_S = 120;

/**
 * Pick a frame to cut a long run at, as close to `target` as possible while
 * preferring silence. Searches a window either side of the target for the
 * longest non-speech stretch and returns its middle, so a split lands between
 * words rather than through one. Falls back to the target itself.
 */
function quietestSplit(
  speechFrames: boolean[],
  lo: number,
  hi: number,
  target: number,
  searchFrames: number
): number {
  const from = Math.max(lo + 1, target - searchFrames);
  const to = Math.min(hi - 1, target + searchFrames);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = from; i < to; ) {
    if (speechFrames[i]) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < to && !speechFrames[j]) j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  if (bestStart < 0) return target;
  return Math.floor(bestStart + bestLen / 2);
}

/**
 * Build contiguous speech segments from per-frame speech flags.
 *
 * 1. Collect raw speech runs
 * 2. Expand each run by `padS`
 * 3. Merge runs whose gap is shorter than `maxGapS`
 * 4. Split runs longer than `maxSegmentS` at their quietest interior point
 * 5. Drop runs shorter than `minSpeechS`
 */
export function speechSegmentsFromFrames(
  speechFrames: boolean[],
  totalSamples: number,
  {
    maxGapS = 1.5,
    padS = 0.25,
    minSpeechS = 0.15,
    maxSegmentS = MAX_SEGMENT_S,
    frameSize = VAD_FRAME_SIZE,
    sampleRate = VAD_SAMPLE_RATE,
  }: SpeechSegmentOptions = {}
): SpeechSegment[] {
  const n = speechFrames.length;
  if (n === 0 || totalSamples === 0) return [];

  const padFrames = Math.max(0, Math.round((padS * sampleRate) / frameSize));
  const maxGapFrames = Math.max(1, Math.round((maxGapS * sampleRate) / frameSize));
  const minSpeechSamples = Math.max(1, Math.round(minSpeechS * sampleRate));

  // Raw [start, end) frame runs.
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < n; ) {
    if (!speechFrames[i]) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && speechFrames[j]) j++;
    runs.push([i, j]);
    i = j;
  }
  if (runs.length === 0) return [];

  // Pad, then merge overlapping / nearby runs in one pass.
  const merged: Array<[number, number]> = [];
  for (const [rawStart, rawEnd] of runs) {
    const start = Math.max(0, rawStart - padFrames);
    const end = Math.min(n, rawEnd + padFrames);
    const prev = merged[merged.length - 1];
    if (prev && start - prev[1] < maxGapFrames) {
      prev[1] = Math.max(prev[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  // Split anything longer than the ceiling, cutting at the quietest frame near
  // each boundary so a split lands between words.
  const maxSegmentFrames = Math.max(
    1,
    Math.round((maxSegmentS * sampleRate) / frameSize)
  );
  // Look a tenth of a segment either way for silence to cut in.
  const searchFrames = Math.max(1, Math.round(maxSegmentFrames / 10));
  const bounded: Array<[number, number]> = [];
  for (const [start, end] of merged) {
    if (end - start <= maxSegmentFrames) {
      bounded.push([start, end]);
      continue;
    }
    // Greedy from the last cut actually made, rather than from an even
    // division of the run: the search for silence moves a boundary by up to
    // `searchFrames`, and measuring the next target from the ideal position
    // lets that drift accumulate past the ceiling.
    let cut = start;
    while (end - cut > maxSegmentFrames) {
      const next = quietestSplit(
        speechFrames,
        cut,
        end,
        cut + maxSegmentFrames,
        searchFrames
      );
      // Only ever move the boundary earlier, so the piece cannot exceed the cap.
      const nextCut = Math.min(next, cut + maxSegmentFrames);
      if (nextCut <= cut) break;
      bounded.push([cut, nextCut]);
      cut = nextCut;
    }
    bounded.push([cut, end]);
  }

  return bounded.flatMap(([startFrame, endFrame]) => {
    const startSample = startFrame * frameSize;
    const endSample =
      endFrame >= n ? totalSamples : Math.min(totalSamples, endFrame * frameSize);
    if (endSample - startSample < minSpeechSamples) return [];
    return [{ startSample, endSample }];
  });
}

/**
 * Lightweight energy-based speech detector used when Silero VAD is unavailable.
 * Frames whose RMS is above `peak * relativeThreshold` (or an absolute floor)
 * are treated as speech.
 */
export function energySpeechFrames(
  audio: Float32Array,
  {
    frameSize = VAD_FRAME_SIZE,
    relativeThreshold = 0.15,
    absoluteFloor = 0.005,
  }: {
    frameSize?: number;
    relativeThreshold?: number;
    absoluteFloor?: number;
  } = {}
): boolean[] {
  const n = Math.ceil(audio.length / frameSize) || 0;
  const energies = new Float32Array(n);
  let peak = 0;
  for (let f = 0; f < n; f++) {
    const start = f * frameSize;
    const end = Math.min(audio.length, start + frameSize);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const x = audio[i];
      sum += x * x;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    energies[f] = rms;
    if (rms > peak) peak = rms;
  }
  const cutoff = Math.max(absoluteFloor, peak * relativeThreshold);
  return Array.from(energies, (e) => e >= cutoff);
}
