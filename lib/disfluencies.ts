/**
 * Detect filled pauses / hesitations that ASR dropped from the transcript.
 *
 * Whisper (and similar models) often omit "um" / "uh". The audio is still
 * speech according to VAD, so those spans show up as speech frames with no
 * covering word. We insert `...` placeholders there so they appear in the
 * transcript / timeline and can be cut via Remove fillers.
 *
 * Pure helpers — takes VAD frame flags directly so tests need no model.
 */
import type { Word } from "./types";
import { VAD_FRAME_SIZE, VAD_SAMPLE_RATE } from "./vad";

/** Marker text for a detected, untranscribed disfluency. */
export const DISFLUENCY_PLACEHOLDER = "...";

/**
 * Minimum uncovered speech (seconds) to emit a placeholder. Must sit above
 * Silero's ~150 ms post-speech hangover so word tails aren't mistaken for fillers.
 */
export const MIN_DISFLUENCY_DURATION = 0.3;

/**
 * Trim this much from the start of an uncovered run that abuts a prior word.
 * Absorbs Silero hangover so the placeholder tracks the filled pause, not the
 * bleed after the previous token.
 */
const HANGOVER_TRIM_S = 0.12;

export interface DisfluencyOptions {
  frameSize?: number;
  sampleRate?: number;
  minDurationS?: number;
  /** Media duration; placeholder ends are clamped to it when > 0. */
  duration?: number;
}

/** Whether `text` is a disfluency placeholder token. */
export function isDisfluencyPlaceholder(text: string): boolean {
  return text.trim() === DISFLUENCY_PLACEHOLDER;
}

/** Contiguous [start, end) runs of uncovered speech, in seconds. */
function uncoveredSpeechRuns(
  words: Word[],
  speechFrames: boolean[],
  frameS: number
): Array<{ start: number; end: number }> {
  if (speechFrames.length === 0) return [];

  const covered = new Uint8Array(speechFrames.length);
  for (const w of words) {
    if (w.deleted) continue;
    const a = Math.max(0, Math.floor(w.start / frameS));
    const b = Math.min(speechFrames.length, Math.ceil(w.end / frameS));
    for (let i = a; i < b; i++) covered[i] = 1;
  }

  const runs: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < speechFrames.length; ) {
    if (!speechFrames[i] || covered[i]) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < speechFrames.length && speechFrames[j] && !covered[j]) j++;
    runs.push({ start: i * frameS, end: j * frameS });
    i = j;
  }
  return runs;
}

/**
 * Insert `...` words over VAD speech that no transcript token covers.
 * Returns a new array (re-indexed); input is untouched. No-op when there are
 * no speech frames or nothing qualifies.
 */
export function insertDisfluencyPlaceholders(
  words: Word[],
  speechFrames: boolean[],
  {
    frameSize = VAD_FRAME_SIZE,
    sampleRate = VAD_SAMPLE_RATE,
    minDurationS = MIN_DISFLUENCY_DURATION,
    duration = 0,
  }: DisfluencyOptions = {}
): Word[] {
  if (speechFrames.length === 0) return words;

  const frameS = frameSize / sampleRate;
  const maxT = duration > 0 ? duration : Infinity;
  const sorted = words.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const runs = uncoveredSpeechRuns(sorted, speechFrames, frameS);
  if (runs.length === 0) return words;

  const placeholders: Word[] = [];
  for (const run of runs) {
    let start = run.start;
    let end = Math.min(run.end, maxT);

    // Hangover after the preceding word is not a filled pause.
    const prev = sorted.filter((w) => !w.deleted && w.end <= start + frameS).pop();
    if (prev && start - prev.end <= frameS + 1e-4) {
      start = Math.min(end, start + HANGOVER_TRIM_S);
    }

    // Don't spill into the next word (alignment / frame rounding).
    const next = sorted.find((w) => !w.deleted && w.start >= start - frameS);
    if (next) end = Math.min(end, next.start);

    if (end - start < minDurationS - 1e-4) continue;
    if (start >= maxT - 1e-4) continue;

    placeholders.push({
      id: -1,
      text: DISFLUENCY_PLACEHOLDER,
      start,
      end,
      speaker: 0,
      deleted: false,
    });
  }

  if (placeholders.length === 0) return words;

  const merged = [...sorted, ...placeholders].sort(
    (a, b) => a.start - b.start || a.end - b.end
  );
  return merged.map((w, i) => (w.id === i ? w : { ...w, id: i }));
}
