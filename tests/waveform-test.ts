import { buildWaveformPeaks, peakBetween } from "../lib/waveform";

/** Reference: what the timeline used to compute straight from the PCM. */
function rawPeak(audio: Float32Array, from: number, to: number): number {
  let lo = 0;
  let hi = 0;
  for (let i = from; i < Math.min(to, audio.length); i++) {
    if (audio[i] < lo) lo = audio[i];
    if (audio[i] > hi) hi = audio[i];
  }
  return Math.min(1, (hi - lo) / 2);
}

const SR = 16_000;

/** A 1 s sine at `freq`, scaled by an envelope over the whole clip. */
function tone(seconds: number, freq: number, amp: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    out[i] = Math.sin(2 * Math.PI * freq * t) * amp(t);
  }
  return out;
}

{
  // Short audio keeps full time resolution.
  const audio = tone(2, 220, () => 0.8);
  const peaks = buildWaveformPeaks(audio);
  console.log("2s bucketSize:", peaks.bucketSize, "buckets:", peaks.min.length);
  if (peaks.bucketSize !== 1) throw new Error("short audio should not be downsampled");
  if (peaks.sampleCount !== audio.length) throw new Error("sampleCount mismatch");
}

{
  // Long audio is capped: this is the property that bounds memory.
  const maxBuckets = 1000;
  const audio = tone(4, 300, () => 0.9);
  const peaks = buildWaveformPeaks(audio, maxBuckets);
  console.log("capped buckets:", peaks.min.length, "bucketSize:", peaks.bucketSize);
  if (peaks.min.length > maxBuckets) throw new Error("bucket cap exceeded");
  const bytes = peaks.min.length + peaks.max.length;
  if (bytes >= audio.length * 4) throw new Error("envelope is not smaller than the PCM");
}

{
  // The envelope must agree with the old raw computation at the resolution the
  // timeline actually draws at.
  const audio = tone(20, 180, (t) => 0.2 + 0.75 * Math.abs(Math.sin(t / 3)));
  const peaks = buildWaveformPeaks(audio, 20_000);
  let worst = 0;
  // 1200 pixel columns across the clip, as the timeline would.
  const columns = 1200;
  const samplesPerColumn = audio.length / columns;
  for (let x = 0; x < columns; x++) {
    const from = Math.floor(x * samplesPerColumn);
    const to = Math.floor(from + samplesPerColumn) + 1;
    const err = Math.abs(peakBetween(peaks, from, to) - rawPeak(audio, from, to));
    if (err > worst) worst = err;
  }
  console.log("worst per-column error:", worst.toFixed(5));
  // Quantisation to signed bytes is 1/127; allow a shade over for bucket edges.
  if (worst > 0.02) throw new Error(`envelope drifts from the PCM by ${worst}`);
}

{
  // A short loud transient must survive downsampling — min/max buckets exist
  // precisely so that averaging cannot swallow it.
  const audio = new Float32Array(SR * 4);
  for (let i = SR * 2; i < SR * 2 + 50; i++) audio[i] = 0.95;
  const peaks = buildWaveformPeaks(audio, 2000);
  const at = peakBetween(peaks, SR * 2 - 10, SR * 2 + 60);
  console.log("transient peak:", at.toFixed(3));
  if (at < 0.4) throw new Error("downsampling swallowed a transient");
  if (peakBetween(peaks, 0, SR) > 0.01) throw new Error("silence should read as silent");
}

{
  // Out-of-range and empty queries are clamped, not crashes.
  const peaks = buildWaveformPeaks(tone(1, 200, () => 0.5));
  if (peakBetween(peaks, -500, 10) < 0) throw new Error("negative start broke the query");
  if (peakBetween(peaks, 1e9, 1e9 + 10) !== peakBetween(peaks, 1e9, 1e9 + 10)) {
    throw new Error("out-of-range query returned NaN");
  }
  const empty = buildWaveformPeaks(new Float32Array(0));
  if (peakBetween(empty, 0, 10) !== 0) throw new Error("empty audio should read as silent");
}

{
  // Hot sources overshoot full scale; the bar must not spill past the lane.
  const audio = new Float32Array(SR);
  for (let i = 0; i < audio.length; i++) audio[i] = i % 2 === 0 ? 1.8 : -1.8;
  const peaks = buildWaveformPeaks(audio);
  if (peakBetween(peaks, 0, SR) > 1) throw new Error("overshoot was not clamped");
}

console.log("ALL WAVEFORM TESTS PASSED");
