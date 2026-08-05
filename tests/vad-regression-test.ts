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
import { MODELS, whisperFillerPrompt } from "../lib/models";
import {
  TRANSCRIPT_LANGUAGE_ORDER,
  type TranscriptLanguage,
} from "../lib/languages";

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

/**
 * Longest `<|startofprev|>` filler prompt considered safe. Lived in lib/models
 * until every model stopped opting in; kept here because the constraint is
 * still real for anything that opts back in, and prod no longer reads it.
 *
 * Note the cap is necessary but not sufficient — Whisper Small collapses a long
 * VAD segment to a bare "Um," with a 20-character prompt, well inside it. That
 * is why `keepFillers` is unset everywhere rather than merely bounded.
 */
const MAX_VERBATIM_PROMPT_LENGTH = 32;

// Short filler prompts are OK; long ones truncate multi-speaker / long-form ASR.
// Not every Whisper model opts in: Medium truncates to a fragment even inside
// the length cap, and the CrisperWhisper checkpoints transcribe fillers without
// prompting. Those are checked in models-test.ts; here we only constrain the
// prompts that do get sent.
let promptedModels = 0;
for (const id of Object.keys(MODELS) as (keyof typeof MODELS)[]) {
  const info = MODELS[id];
  if (info.backend !== "whisper" || !info.keepFillers) continue;
  promptedModels++;
  for (const language of TRANSCRIPT_LANGUAGE_ORDER) {
    const prompt = whisperFillerPrompt(id, language);
    assert(!!prompt, `${id}/${language} must resolve a filler prompt`);
    assert(
      prompt!.length <= MAX_VERBATIM_PROMPT_LENGTH,
      `${id}/${language} filler prompt too long (${prompt!.length} > ${MAX_VERBATIM_PROMPT_LENGTH})`
    );
    assert(
      !/\bI'm\b/i.test(prompt!),
      `${id}/${language} filler prompt must not contain "I'm" (seeds hallucination loops)`
    );
  }
}
// Currently zero: the prompt truncates long segments badly enough that every
// model opts out (see WhisperModelInfo.keepFillers). The loop above is a
// standing constraint on anything that opts back in, not a claim that something
// does — so it is deliberately allowed to be empty.
void promptedModels;
assert(
  whisperFillerPrompt("parakeet", "en" as TranscriptLanguage) === null,
  "parakeet must not use Whisper filler prompts"
);
console.log("whisper filler prompts stay short: ok");

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
