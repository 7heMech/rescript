/**
 * Voice-activity helpers used to reduce Whisper hallucinations on long
 * silence / music stretches.
 *
 * Strategy: detect speech frames, then zero out contiguous silent regions
 * longer than a threshold. Timeline length is preserved so word timestamps
 * stay aligned with the media.
 */

export const VAD_SAMPLE_RATE = 16_000;
/** Silero VAD expects 512-sample frames at 16 kHz (~32 ms). */
export const VAD_FRAME_SIZE = 512;

export interface MuteSilenceOptions {
  /** Minimum contiguous silence (seconds) to mute. Default 1.5. */
  minSilenceS?: number;
  /** Keep this much audio (seconds) on each side of speech. Default 0.25. */
  padS?: number;
  frameSize?: number;
}

/**
 * Expand speech regions by `padFrames` on each side, then mark long silent
 * gaps as mute targets. Returns a per-sample boolean mask where `true` means
 * "keep" (speech or short pause).
 */
export function keepMaskFromSpeechFrames(
  speechFrames: boolean[],
  totalSamples: number,
  {
    minSilenceS = 1.5,
    padS = 0.25,
    frameSize = VAD_FRAME_SIZE,
    sampleRate = VAD_SAMPLE_RATE,
  }: MuteSilenceOptions & { sampleRate?: number } = {}
): boolean[] {
  const n = speechFrames.length;
  if (n === 0 || totalSamples === 0) {
    return new Array(totalSamples).fill(false);
  }

  const padFrames = Math.max(0, Math.round((padS * sampleRate) / frameSize));
  const minSilenceFrames = Math.max(
    1,
    Math.round((minSilenceS * sampleRate) / frameSize)
  );

  // Dilate speech so we don't clip phoneme edges.
  const padded = speechFrames.slice();
  for (let i = 0; i < n; i++) {
    if (!speechFrames[i]) continue;
    const lo = Math.max(0, i - padFrames);
    const hi = Math.min(n - 1, i + padFrames);
    for (let j = lo; j <= hi; j++) padded[j] = true;
  }

  // Start by keeping everything; only mute long silent runs.
  const keepFrames = new Array(n).fill(true);
  let i = 0;
  while (i < n) {
    if (padded[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !padded[j]) j++;
    if (j - i >= minSilenceFrames) {
      for (let k = i; k < j; k++) keepFrames[k] = false;
    }
    i = j;
  }

  const keep = new Array(totalSamples).fill(false);
  for (let f = 0; f < n; f++) {
    if (!keepFrames[f]) continue;
    const start = f * frameSize;
    const end = Math.min(totalSamples, start + frameSize);
    for (let s = start; s < end; s++) keep[s] = true;
  }
  // Trailing partial frame after the last full VAD frame.
  if (n * frameSize < totalSamples && keepFrames[n - 1]) {
    for (let s = n * frameSize; s < totalSamples; s++) keep[s] = true;
  }
  return keep;
}

/**
 * Return a copy of `audio` with long silent regions zeroed. Short pauses
 * inside speech are left intact.
 */
export function muteLongSilence(
  audio: Float32Array,
  speechFrames: boolean[],
  options?: MuteSilenceOptions
): Float32Array {
  const frameSize = options?.frameSize ?? VAD_FRAME_SIZE;
  const keep = keepMaskFromSpeechFrames(speechFrames, audio.length, {
    ...options,
    frameSize,
  });
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    if (keep[i]) out[i] = audio[i];
  }
  return out;
}

/**
 * Lightweight energy-based speech detector used when Silero VAD is unavailable.
 * Frames whose RMS is above `floor * relativeThreshold` (or an absolute floor)
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
