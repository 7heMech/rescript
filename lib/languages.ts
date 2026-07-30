export type TranscriptLanguage = "en" | "de";

export interface TranscriptLanguageInfo {
  label: string;
  nativeLabel: string;
  whisperCode: TranscriptLanguage;
}

const LANGUAGE_STORAGE_KEY = "rescript.transcript-language";

export const TRANSCRIPT_LANGUAGES: Record<
  TranscriptLanguage,
  TranscriptLanguageInfo
> = {
  en: {
    label: "English",
    nativeLabel: "English",
    whisperCode: "en",
  },
  de: {
    label: "German",
    nativeLabel: "Deutsch",
    whisperCode: "de",
  },
};

export const TRANSCRIPT_LANGUAGE_ORDER: TranscriptLanguage[] = ["en", "de"];

export function isTranscriptLanguage(
  value: unknown
): value is TranscriptLanguage {
  return value === "en" || value === "de";
}

/** Read the last-selected transcript language from localStorage. */
export function loadTranscriptLanguagePreference(): TranscriptLanguage {
  if (typeof window === "undefined") return "en";
  try {
    const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isTranscriptLanguage(raw)) return raw;
  } catch {
    // private mode / disabled storage
  }
  return "en";
}

/** Persist the selected transcript language for the next visit. */
export function saveTranscriptLanguagePreference(language: TranscriptLanguage) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // private mode / disabled storage
  }
}
