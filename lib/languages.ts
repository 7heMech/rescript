export type TranscriptLanguage = "auto" | "en" | "es" | "fr" | "de" | "zh";

export interface TranscriptLanguageInfo {
  label: string;
  nativeLabel: string;
  /** Whisper language code; null means auto-detect. */
  whisperCode: string | null;
}

const LANGUAGE_STORAGE_KEY = "rescript.transcript-language";

export const DEFAULT_TRANSCRIPT_LANGUAGE: TranscriptLanguage = "auto";

export const TRANSCRIPT_LANGUAGES: Record<
  TranscriptLanguage,
  TranscriptLanguageInfo
> = {
  auto: {
    label: "Auto",
    nativeLabel: "Auto",
    whisperCode: null,
  },
  en: {
    label: "English",
    nativeLabel: "English",
    whisperCode: "en",
  },
  es: {
    label: "Spanish",
    nativeLabel: "Español",
    whisperCode: "es",
  },
  fr: {
    label: "French",
    nativeLabel: "Français",
    whisperCode: "fr",
  },
  de: {
    label: "German",
    nativeLabel: "Deutsch",
    whisperCode: "de",
  },
  zh: {
    label: "Chinese",
    nativeLabel: "中文",
    whisperCode: "zh",
  },
};

export const TRANSCRIPT_LANGUAGE_ORDER: TranscriptLanguage[] = [
  "auto",
  "en",
  "es",
  "fr",
  "de",
  "zh",
];

export function isTranscriptLanguage(
  value: unknown
): value is TranscriptLanguage {
  return (
    value === "auto" ||
    value === "en" ||
    value === "es" ||
    value === "fr" ||
    value === "de" ||
    value === "zh"
  );
}

/** Read the last-selected transcript language from localStorage. */
export function loadTranscriptLanguagePreference(): TranscriptLanguage {
  if (typeof window === "undefined") return DEFAULT_TRANSCRIPT_LANGUAGE;
  try {
    const raw = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isTranscriptLanguage(raw)) return raw;
  } catch {
    // private mode / disabled storage
  }
  return DEFAULT_TRANSCRIPT_LANGUAGE;
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
