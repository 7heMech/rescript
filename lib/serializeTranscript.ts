import { getCutRanges, originalToEdited } from "./edits";
import { groupWordsBySpeaker } from "./transcript";
import type { TimeRange, Word } from "./types";

/** Timed caption / subtitle formats (importable). */
export type SubtitleFormat = "srt" | "vtt" | "json";

/** Untimed transcript document formats. */
export type TranscriptDocFormat = "txt" | "md";

export type TranscriptFormat = SubtitleFormat | TranscriptDocFormat;

export interface SerializeOptions {
  /**
   * When true (default for SRT/VTT/TXT/MD), omit cut words and remap times onto
   * the edited timeline so captions sync with the exported media.
   * JSON ignores this and always writes the full word list for round-trips.
   */
  editedTimeline?: boolean;
  /** Media duration in seconds; used when remapping onto the edited timeline. */
  duration?: number;
  /**
   * Precomputed cut ranges (deleted words ∪ manual cuts). Preferred so caption
   * times match the media export. Falls back to word-derived cuts when omitted.
   */
  cuts?: TimeRange[];
}

interface Cue {
  start: number;
  end: number;
  text: string;
  speaker: number;
}

/** Split a cue when the gap between consecutive words exceeds this (seconds). */
const CUE_GAP = 0.75;

const MIME: Record<TranscriptFormat, string> = {
  srt: "application/x-subrip",
  vtt: "text/vtt",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
};

export function transcriptMime(format: TranscriptFormat): string {
  return MIME[format];
}

export function transcriptExtension(format: TranscriptFormat): string {
  return `.${format}`;
}

/**
 * Serialize editor words to a subtitle or transcript document format.
 * SRT/VTT group consecutive same-speaker words into cues (splitting on gaps).
 * TXT/MD write speaker-labeled turns without timestamps.
 * JSON writes `{ "words": [...] }` matching `parseTranscript` import.
 */
export function serializeTranscript(
  words: Word[],
  format: TranscriptFormat,
  options: SerializeOptions = {}
): string {
  if (format === "json") return serializeJson(words);
  if (format === "txt" || format === "md") {
    return serializeDocument(words, format, options);
  }

  const editedTimeline = options.editedTimeline !== false;
  const prepared = prepareCaptionWords(words, editedTimeline, options);
  if (prepared.length === 0) {
    throw new Error("No words to export.");
  }
  const cues = wordsToCues(prepared);
  return format === "vtt" ? serializeVtt(cues) : serializeSrt(cues);
}

/** Trigger a browser download of the serialized transcript / subtitles. */
export function downloadTranscript(
  words: Word[],
  format: TranscriptFormat,
  filename: string,
  options: SerializeOptions = {}
): void {
  const text = serializeTranscript(words, format, options);
  const blob = new Blob([text], { type: `${MIME[format]};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(`.${format}`)
    ? filename
    : `${filename}${transcriptExtension(format)}`;
  a.click();
  URL.revokeObjectURL(url);
}

function serializeJson(words: Word[]): string {
  return JSON.stringify(
    {
      words: words.map((w) => ({
        text: w.text,
        start: roundTime(w.start),
        end: roundTime(w.end),
        speaker: w.speaker,
        deleted: w.deleted,
      })),
    },
    null,
    2
  );
}

function serializeDocument(
  words: Word[],
  format: TranscriptDocFormat,
  options: SerializeOptions
): string {
  const editedTimeline = options.editedTimeline !== false;
  const prepared = prepareCaptionWords(words, editedTimeline, options);
  if (prepared.length === 0) {
    throw new Error("No words to export.");
  }

  const turns = groupWordsBySpeaker(prepared);
  if (format === "txt") {
    return (
      turns
        .map((turn) => {
          const label =
            turn.speaker >= 0 ? `Speaker ${turn.speaker + 1}` : "Speaker";
          const text = turn.words.map((w) => w.text).join(" ");
          return `${label}: ${text}`;
        })
        .join("\n\n") + "\n"
    );
  }

  return (
    turns
      .map((turn) => {
        const label =
          turn.speaker >= 0 ? `Speaker ${turn.speaker + 1}` : "Speaker";
        const text = turn.words.map((w) => w.text).join(" ");
        return `**${label}**\n\n${text}`;
      })
      .join("\n\n") + "\n"
  );
}

function prepareCaptionWords(
  words: Word[],
  editedTimeline: boolean,
  options: SerializeOptions
): Word[] {
  const duration = options.duration ?? 0;
  const cuts =
    options.cuts ??
    getCutRanges(words, duration > 0 ? duration : Infinity);

  const kept = words.filter((w) => isWordKept(w, cuts));
  if (!editedTimeline || kept.length === 0 || cuts.length === 0) return kept;

  return kept.map((w) => ({
    ...w,
    start: originalToEdited(w.start, cuts),
    end: originalToEdited(w.end, cuts),
  }));
}

/** Keep words that are not deleted and whose midpoint survives the cut list. */
function isWordKept(word: Word, cuts: TimeRange[]): boolean {
  if (word.deleted) return false;
  const mid = (word.start + word.end) / 2;
  return !cuts.some((c) => mid >= c.start && mid < c.end);
}

function wordsToCues(words: Word[]): Cue[] {
  const cues: Cue[] = [];
  let batch: Word[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    cues.push({
      start: batch[0].start,
      end: Math.max(batch[batch.length - 1].end, batch[0].start + 0.02),
      text: batch.map((w) => w.text).join(" "),
      speaker: batch[0].speaker,
    });
    batch = [];
  };

  for (const w of words) {
    const last = batch[batch.length - 1];
    if (
      last &&
      (w.speaker !== last.speaker || w.start - last.end > CUE_GAP)
    ) {
      flush();
    }
    batch.push(w);
  }
  flush();
  return cues;
}

function serializeSrt(cues: Cue[]): string {
  return (
    cues
      .map((cue, i) => {
        const lines = [
          String(i + 1),
          `${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}`,
        ];
        if (cue.speaker >= 0) {
          lines.push(`Speaker ${cue.speaker + 1}: ${cue.text}`);
        } else {
          lines.push(cue.text);
        }
        return lines.join("\n");
      })
      .join("\n\n") + "\n"
  );
}

function serializeVtt(cues: Cue[]): string {
  const body = cues
    .map((cue) => {
      const timing = `${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}`;
      const text =
        cue.speaker >= 0
          ? `<v Speaker ${cue.speaker + 1}>${cue.text}`
          : cue.text;
      return `${timing}\n${text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

/** SRT timestamps use a comma decimal separator: `HH:MM:SS,mmm`. */
export function formatSrtTimestamp(seconds: number): string {
  return formatCaptionTimestamp(seconds, ",");
}

/** WebVTT timestamps use a dot decimal separator: `HH:MM:SS.mmm`. */
export function formatVttTimestamp(seconds: number): string {
  return formatCaptionTimestamp(seconds, ".");
}

function formatCaptionTimestamp(seconds: number, decimal: "," | "."): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  // Carry if rounding pushed ms to 1000.
  const carry = ms === 1000 ? 1 : 0;
  const msClamped = ms === 1000 ? 0 : ms;
  const s2 = s + carry;
  const m2 = m + Math.floor(s2 / 60);
  const h2 = h + Math.floor(m2 / 60);
  return (
    `${pad(h2, 2)}:${pad(m2 % 60, 2)}:${pad(s2 % 60, 2)}` +
    `${decimal}${pad(msClamped, 3)}`
  );
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function roundTime(t: number): number {
  return Math.round(t * 1000) / 1000;
}
