import type { SpeakerTurn, Word } from "./types";

export function findActiveWordId(words: Word[], timeS: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= timeS) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx >= 0 && timeS < words[idx].end + 0.15) return words[idx].id;
  return -1;
}

export function groupWordsBySpeaker(words: Word[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const word of words) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === word.speaker) last.words.push(word);
    else turns.push({ speaker: word.speaker, words: [word] });
  }
  return turns;
}
