/**
 * Regression: silence-skip + ASR knobs must keep both speakers on the mixed
 * testaudio_44100_test01_20s clip (woman then man, ~2s–22s of speech).
 *
 * Requires ffmpeg on PATH. Skips the audio coverage check if the wav is missing
 * or ffmpeg is unavailable.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  energySpeechFrames,
  speechSegmentsFromFrames,
  VAD_SAMPLE_RATE,
} from "../lib/vad";
import { MODELS } from "../lib/models";

const wav = path.join(
  process.cwd(),
  "tests/fixtures/testaudio_44100_test01_20s.wav"
);

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function ffmpegAvailable(): boolean {
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return probe.status === 0;
}

// Long decoder prompts truncate long-form ASR — models must not set them.
for (const id of Object.keys(MODELS) as (keyof typeof MODELS)[]) {
  assert(
    !MODELS[id].verbatimPrompt,
    `${id} must not set verbatimPrompt (truncates multi-speaker clips)`
  );
}
console.log("models have no verbatimPrompt: ok");

const workerSrc = fs.readFileSync(
  path.join(process.cwd(), "workers/transcription.worker.ts"),
  "utf8"
);

// High repetition_penalty truncates this clip mid-utterance even on full audio.
const penaltyMatch = workerSrc.match(/repetition_penalty:\s*([0-9.]+)/);
if (!penaltyMatch) throw new Error("worker must set repetition_penalty");
const penalty = Number(penaltyMatch[1]);
assert(
  penalty > 1 && penalty <= 1.05,
  `repetition_penalty must be <= 1.05 (was ${penalty}; 1.15 drops the second speaker)`
);
console.log(`repetition_penalty ${penalty}: ok`);

// VAD slices that start on speech need a short zero lead-in or Whisper EOS
// after the first speaker.
const leadMatch = workerSrc.match(/WHISPER_LEAD_PAD_S\s*=\s*([0-9.]+)/);
if (!leadMatch) throw new Error("worker must define WHISPER_LEAD_PAD_S");
const leadPad = Number(leadMatch[1]);
assert(
  leadPad >= 0.5,
  `WHISPER_LEAD_PAD_S must be >= 0.5s (was ${leadPad})`
);
console.log(`WHISPER_LEAD_PAD_S ${leadPad}s: ok`);

if (!fs.existsSync(wav)) {
  console.warn("SKIP: test wav not found at", wav);
  process.exit(0);
}

if (!ffmpegAvailable()) {
  console.warn("SKIP: ffmpeg not found on PATH; audio coverage check skipped");
  process.exit(0);
}

const pcmPath = path.join(
  os.tmpdir(),
  `rescript-vad-regression-${process.pid}.pcm`
);
const ff = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    wav,
    "-ac",
    "1",
    "-ar",
    String(VAD_SAMPLE_RATE),
    "-f",
    "f32le",
    pcmPath,
  ],
  { encoding: "utf8" }
);
if (ff.status !== 0) {
  console.warn("SKIP: ffmpeg resample failed; audio coverage check skipped");
  if (ff.stderr) console.warn(ff.stderr);
  process.exit(0);
}

const buf = fs.readFileSync(pcmPath);
const audio = new Float32Array(
  buf.buffer,
  buf.byteOffset,
  buf.byteLength / 4
);
fs.unlinkSync(pcmPath);

const frames = energySpeechFrames(audio);
const segments = speechSegmentsFromFrames(frames, audio.length, {
  maxGapS: 1.5,
  padS: 0.4,
});

assert(segments.length >= 1, "expected at least one speech segment");

const coverStart =
  Math.min(...segments.map((s) => s.startSample)) / VAD_SAMPLE_RATE;
const coverEnd =
  Math.max(...segments.map((s) => s.endSample)) / VAD_SAMPLE_RATE;

// Woman starts ~2s; man continues past ~12s through ~21s.
assert(coverStart <= 2.5, `speech should start by 2.5s, got ${coverStart}`);
assert(
  coverEnd >= 20,
  `speech should cover past 20s (male voice), got ${coverEnd}`
);

const covered = segments.reduce(
  (n, s) => n + (s.endSample - s.startSample),
  0
);
const coverage = covered / audio.length;
assert(
  coverage > 0.7,
  `expected >70% speech coverage, got ${(coverage * 100).toFixed(1)}%`
);

console.log(
  `VAD coverage ${coverStart.toFixed(2)}s–${coverEnd.toFixed(2)}s ` +
    `(${segments.length} segment(s), ${(coverage * 100).toFixed(1)}%): ok`
);
console.log("ALL VAD REGRESSION TESTS PASSED");
