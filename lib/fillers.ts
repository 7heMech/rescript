import { isDisfluencyPlaceholder } from "./disfluencies";
import type { Word } from "./types";

/**
 * Filler sounds that carry no meaning and can safely be cut. Deliberately
 * conservative: ambiguous words like "like", "so" or "right" are excluded
 * because they are usually legitimate. Also includes `[*]` placeholders for
 * filled pauses ASR dropped (see lib/disfluencies.ts).
 */
const FILLER_WORDS = new Set([
  // English
  "um",
  "umm",
  "ummm",
  "uh",
  "uhh",
  "uhm",
  "erm",
  "er",
  "err",
  "ah",
  "ahh",
  "eh",
  "ehm",
  // German
  "äh",
  "ähh",
  "ähhh",
  "ähm",
  "ähmm",
  "öh",
  "öhm",
  "ööhm",
  // French
  "euh",
  "euuh",
  "euuuh",
  "euhm",
  "heu",
  "heum",
  // Spanish
  "em",
  "emm",
  "emmm",
  "eee",
  // Chinese
  "嗯",
  "嗯嗯",
  "呃",
  "额",
  "唔",
  // Shared hums / acknowledgements
  "hm",
  "hmm",
  "hmmm",
  "mh",
  "mhh",
  "mm",
  "mmm",
  "mhm",
  "mm-hmm",
  "uh-huh",
]);

/** Normalize a transcript token for matching: lowercase, strip punctuation. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, "");
}

export function isFillerWord(text: string): boolean {
  if (isDisfluencyPlaceholder(text)) return true;
  return FILLER_WORDS.has(normalize(text));
}

/** Ids of all not-yet-deleted filler words in the transcript. */
export function findFillerWordIds(words: Word[]): number[] {
  return words.filter((w) => !w.deleted && isFillerWord(w.text)).map((w) => w.id);
}
