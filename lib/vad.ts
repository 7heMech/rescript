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
  frameSize?: number;
  sampleRate?: number;
}

/**
 * Build contiguous speech segments from per-frame speech flags.
 * Short silent gaps are absorbed; long gaps become segment boundaries.
 */
export function speechSegmentsFromFrames(
  speechFrames: boolean[],
  totalSamples: number,
  {
    maxGapS = 1.5,
    padS = 0.25,
    minSpeechS = 0.15,
    frameSize = VAD_FRAME_SIZE,
    sampleRate = VAD_SAMPLE_RATE,
  }: SpeechSegmentOptions = {}
): SpeechSegment[] {
  const n = speechFrames.length;
  if (n === 0 || totalSamples === 0) return [];

  const padFrames = Math.max(0, Math.round((padS * sampleRate) / frameSize));
  const maxGapFrames = Math.max(
    1,
    Math.round((maxGapS * sampleRate) / frameSize)
  );
  const minSpeechSamples = Math.max(
    1,
    Math.round(minSpeechS * sampleRate)
  );

  // Dilate speech so we don't clip phoneme edges.
  const padded = speechFrames.slice();
  for (let i = 0; i < n; i++) {
    if (!speechFrames[i]) continue;
    const lo = Math.max(0, i - padFrames);
    const hi = Math.min(n - 1, i + padFrames);
    for (let j = lo; j <= hi; j++) padded[j] = true;
  }

  // Absorb short silent gaps so a breath does not split a sentence.
  const merged = padded.slice();
  let i = 0;
  while (i < n) {
    if (merged[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !padded[j]) j++;
    const gap = j - i;
    const touchesSpeech = i > 0 && j < n;
    if (touchesSpeech && gap < maxGapFrames) {
      for (let k = i; k < j; k++) merged[k] = true;
    }
    i = j;
  }

  const segments: SpeechSegment[] = [];
  i = 0;
  while (i < n) {
    if (!merged[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && merged[j]) j++;
    const startSample = i * frameSize;
    // Include a trailing partial frame when the last speech frame is the
    // final VAD frame and samples remain past n * frameSize.
    let endSample = Math.min(totalSamples, j * frameSize);
    if (j === n) endSample = totalSamples;
    if (endSample - startSample >= minSpeechSamples) {
      segments.push({ startSample, endSample });
    }
    i = j;
  }
  return segments;
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
  const out: boolean[] = new Array(n);
  for (let f = 0; f < n; f++) out[f] = energies[f] >= cutoff;
  return out;
}
