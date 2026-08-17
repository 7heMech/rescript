/**
 * Speaker metadata helpers and pure edit operations.
 *
 * Words carry a numeric `speaker` id; display names live in `SpeakerInfo[]`.
 * Diarization / import create the initial list; the user can rename, reassign,
 * move turn boundaries, add, merge, and remove speakers from the transcript.
 */

import type { SpeakerInfo, Word } from "./types";

export const SPEAKER_COLORS = [
  "#16a34a", // green
  "#2563eb", // blue
  "#9333ea", // purple
  "#ea580c", // orange
  "#0d9488", // teal
  "#db2777", // pink
] as const;

export function speakerColor(id: number): string {
  return SPEAKER_COLORS[Math.max(0, id) % SPEAKER_COLORS.length];
}

export function defaultSpeakerName(id: number): string {
  return id >= 0 ? `Speaker ${id + 1}` : "Speaker";
}

export function speakerLabel(
  speakers: SpeakerInfo[],
  id: number
): string {
  if (id < 0) return "Speaker";
  return speakers.find((s) => s.id === id)?.name ?? defaultSpeakerName(id);
}

/** Build / refresh the speaker list from word ids, preserving known names. */
export function speakersFromWords(
  words: Word[],
  existing: SpeakerInfo[] = []
): SpeakerInfo[] {
  const byId = new Map(existing.map((s) => [s.id, s]));
  const ids = new Set<number>();
  for (const w of words) {
    if (w.speaker >= 0) ids.add(w.speaker);
  }
  // Keep speakers the user added even if no words currently use them.
  for (const s of existing) ids.add(s.id);

  return [...ids]
    .sort((a, b) => a - b)
    .map((id) => byId.get(id) ?? { id, name: defaultSpeakerName(id) });
}

export function nextSpeakerId(speakers: SpeakerInfo[]): number {
  return speakers.reduce((m, s) => Math.max(m, s.id), -1) + 1;
}

export function addSpeaker(
  speakers: SpeakerInfo[],
  name?: string
): { speakers: SpeakerInfo[]; id: number } {
  const id = nextSpeakerId(speakers);
  const trimmed = name?.trim();
  const entry: SpeakerInfo = {
    id,
    name: trimmed && trimmed.length > 0 ? trimmed : defaultSpeakerName(id),
  };
  return { speakers: [...speakers, entry], id };
}

export function renameSpeaker(
  speakers: SpeakerInfo[],
  id: number,
  name: string
): SpeakerInfo[] {
  const trimmed = name.trim();
  if (!trimmed) return speakers;
  const has = speakers.some((s) => s.id === id);
  if (!has) {
    return [...speakers, { id, name: trimmed }].sort((a, b) => a.id - b.id);
  }
  return speakers.map((s) => (s.id === id ? { ...s, name: trimmed } : s));
}

/** Find a speaker by case-insensitive name, or null. */
export function findSpeakerByName(
  speakers: SpeakerInfo[],
  name: string
): SpeakerInfo | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return speakers.find((s) => s.name.trim().toLowerCase() === key) ?? null;
}

export function reassignWords(
  words: Word[],
  ids: Iterable<number>,
  toSpeaker: number
): Word[] {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  if (idSet.size === 0) return words;
  let changed = false;
  const next = words.map((w) => {
    if (!idSet.has(w.id) || w.speaker === toSpeaker) return w;
    changed = true;
    return { ...w, speaker: toSpeaker };
  });
  return changed ? next : words;
}

/**
 * Merge every word (and the speaker entry) from `fromId` into `toId`.
 * No-op when the ids match or `toId` is missing from the project list.
 */
export function replaceSpeaker(
  words: Word[],
  speakers: SpeakerInfo[],
  fromId: number,
  toId: number
): { words: Word[]; speakers: SpeakerInfo[] } | null {
  if (fromId === toId) return null;
  if (!speakers.some((s) => s.id === toId)) return null;
  if (!speakers.some((s) => s.id === fromId)) return null;
  return {
    words: words.map((w) =>
      w.speaker === fromId ? { ...w, speaker: toId } : w
    ),
    speakers: speakers.filter((s) => s.id !== fromId),
  };
}

/**
 * Remove a speaker from the project. Each of their turns is reassigned to the
 * speaker of the preceding word ("speaker above"). Turns at the start of the
 * transcript take the following speaker when one exists.
 */
export function removeSpeaker(
  words: Word[],
  speakers: SpeakerInfo[],
  id: number
): { words: Word[]; speakers: SpeakerInfo[] } | null {
  if (!speakers.some((s) => s.id === id)) return null;
  if (speakers.length <= 1) return null;

  const nextWords = words.map((w, i) => {
    if (w.speaker !== id) return w;
    let replacement = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (words[j].speaker !== id) {
        replacement = words[j].speaker;
        break;
      }
    }
    if (replacement < 0) {
      for (let j = i + 1; j < words.length; j++) {
        if (words[j].speaker !== id) {
          replacement = words[j].speaker;
          break;
        }
      }
    }
    if (replacement < 0) {
      // Sole remaining voice after filter — pick another speaker id.
      replacement = speakers.find((s) => s.id !== id)?.id ?? 0;
    }
    return { ...w, speaker: replacement };
  });

  return {
    words: nextWords,
    speakers: speakers.filter((s) => s.id !== id),
  };
}

/**
 * Move the start of a speaker turn to `targetWordId`, adjusting the boundary
 * with the previous turn. Target must lie within the previous turn or this one.
 */
export function moveSpeakerBoundary(
  words: Word[],
  turnStartWordId: number,
  targetWordId: number
): Word[] | null {
  const startIdx = words.findIndex((w) => w.id === turnStartWordId);
  const targetIdx = words.findIndex((w) => w.id === targetWordId);
  if (startIdx <= 0 || targetIdx < 0 || targetIdx === startIdx) return null;

  const speaker = words[startIdx].speaker;
  const prevSpeaker = words[startIdx - 1].speaker;
  if (prevSpeaker === speaker) return null;

  let turnEnd = startIdx + 1;
  while (turnEnd < words.length && words[turnEnd].speaker === speaker) {
    turnEnd++;
  }

  let prevStart = startIdx - 1;
  while (prevStart > 0 && words[prevStart - 1].speaker === prevSpeaker) {
    prevStart--;
  }

  if (targetIdx < prevStart || targetIdx >= turnEnd) return null;

  let changed = false;
  const next = words.map((w, i) => {
    if (i >= prevStart && i < targetIdx) {
      if (w.speaker === prevSpeaker) return w;
      changed = true;
      return { ...w, speaker: prevSpeaker };
    }
    if (i >= targetIdx && i < turnEnd) {
      if (w.speaker === speaker) return w;
      changed = true;
      return { ...w, speaker: speaker };
    }
    return w;
  });
  return changed ? next : null;
}
