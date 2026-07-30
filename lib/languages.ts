export type TranscriptLanguage = "en" | "es" | "fr" | "de" | "zh";

export interface TranscriptLanguageInfo {
  label: string;
  nativeLabel: string;
  /** Flag emoji shown beside the language name. */
  flag: string;
  /** Compact locale tag shown in the model selector trigger. */
  locale: string;
}

const LANGUAGE_STORAGE_KEY = "rescript.transcript-language";

export const DEFAULT_TRANSCRIPT_LANGUAGE: TranscriptLanguage = "en";

export const TRANSCRIPT_LANGUAGES: Record<
  TranscriptLanguage,
  TranscriptLanguageInfo
> = {
  en: {
    label: "English",
    nativeLabel: "English",
    flag: "🇺🇸",
    locale: "en-US",
  },
  es: {
    label: "Spanish",
    nativeLabel: "Español",
    flag: "🇪🇸",
    locale: "es-ES",
  },
  fr: {
    label: "French",
    nativeLabel: "Français",
    flag: "🇫🇷",
    locale: "fr-FR",
  },
  de: {
    label: "German",
    nativeLabel: "Deutsch",
    flag: "🇩🇪",
    locale: "de-DE",
  },
  zh: {
    label: "Chinese",
    nativeLabel: "中文",
    flag: "🇨🇳",
    locale: "zh-CN",
  },
};

export const TRANSCRIPT_LANGUAGE_ORDER: TranscriptLanguage[] = [
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
