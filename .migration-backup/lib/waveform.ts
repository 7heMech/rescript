/**
 * Downsampled min/max envelope of the audio, for drawing the timeline waveform.
 *
 * The timeline is the only thing on the main thread that ever wanted the raw
 * PCM, and it does not really want it: at every zoom level it collapses a span
 * of samples down to one min/max pair per pixel column. Keeping the decoded
 * Float32Array around to recompute that is expensive in the one place we can
 * least afford it — an hour of mono 16 kHz float32 is 230 MB, held for the whole
 * session, alongside the model weights and the onnxruntime heap. WebKit reloads
 * the tab well before that adds up.
 *
 * So the envelope is computed once, the raw buffer is handed to the worker, and
 * the main thread keeps a few megabytes instead of a few hundred.
 */

export interface WaveformPeaks {
  /** Source samples summarised by each min/max pair. */
  bucketSize: number;
  /** Length of the audio this was built from, in samples. */
  sampleCount: number;
  /** Per-bucket extremes, quantised to signed bytes. */
  min: Int8Array;
  max: Int8Array;
}

/**
 * Envelope resolution ceiling — about 4 MB at two bytes per bucket.
 *
 * This is comfortably finer than the timeline can render. The finest span the
 * timeline ever asks for is one pixel at maximum zoom, i.e.
 * `sampleCount / (trackWidthPx * MAX_ZOOM)` samples; with a 256x zoom cap that
 * stays coarser than `sampleCount / 2e6` for any track narrower than ~7800 px.
 * Media short enough to fall under the cap keeps full sample resolution.
 */
const MAX_BUCKETS = 2_000_000;

/** Quantise [-1, 1] to a signed byte, clamping the overshoot hot sources have. */
function quantise(v: number): number {
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(clamped * 127);
}

/**
 * Summarise `audio` into a min/max envelope.
 *
 * One pass, no allocation beyond the two output arrays. `bucketSize` is 1 —
 * i.e. lossless in time, only quantised in amplitude — whenever the audio is
 * short enough for that to fit under {@link MAX_BUCKETS}.
 */
export function buildWaveformPeaks(
  audio: Float32Array,
  maxBuckets = MAX_BUCKETS
): WaveformPeaks {
  const sampleCount = audio.length;
  const bucketSize = Math.max(1, Math.ceil(sampleCount / Math.max(1, maxBuckets)));
  const buckets = Math.ceil(sampleCount / bucketSize);
  const min = new Int8Array(buckets);
  const max = new Int8Array(buckets);

  for (let b = 0; b < buckets; b++) {
    const from = b * bucketSize;
    const to = Math.min(sampleCount, from + bucketSize);
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to; i++) {
      const v = audio[i];
      if (v < lo) lo = v;
      else if (v > hi) hi = v;
    }
    min[b] = quantise(lo);
    max[b] = quantise(hi);
  }
  return { bucketSize, sampleCount, min, max };
}

/**
 * Peak amplitude over `[startSample, endSample)`, as a 0..1 fraction of full
 * scale — half the peak-to-peak swing, which is what the timeline draws.
 *
 * Buckets are inclusive at both ends, so a span never reads as silent just
 * because it fell between two of them.
 */
export function peakBetween(
  peaks: WaveformPeaks,
  startSample: number,
  endSample: number
): number {
  const { bucketSize, min, max } = peaks;
  const buckets = min.length;
  if (buckets === 0) return 0;
  const from = Math.max(0, Math.min(buckets - 1, Math.floor(startSample / bucketSize)));
  const to = Math.max(from, Math.min(buckets - 1, Math.floor((endSample - 1) / bucketSize)));

  let lo = 0;
  let hi = 0;
  for (let b = from; b <= to; b++) {
    if (min[b] < lo) lo = min[b];
    if (max[b] > hi) hi = max[b];
  }
  return Math.min(1, (hi - lo) / 2 / 127);
}
