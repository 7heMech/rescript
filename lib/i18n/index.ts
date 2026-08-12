import { en, type MessageKey } from "./messages/en";
import { zhCN } from "./messages/zh-CN";
import { runtimeMessageKeys } from "./runtimeMessages";

export type { MessageKey } from "./messages/en";
export {
  runtimeEnglishMessages,
  runtimeMessageKeys,
  type RuntimeMessageKey,
} from "./runtimeMessages";

export type UiLocale = "en" | "zh-CN";
export type UiLocalePreference = "system" | UiLocale;

export const DEFAULT_UI_LOCALE_PREFERENCE: UiLocalePreference = "system";
export const UI_LOCALE_STORAGE_KEY = "rescript.ui-locale";

export type Translate = (
  key: MessageKey,
  params?: Record<string, string | number>
) => string;

export function isUiLocalePreference(value: unknown): value is UiLocalePreference {
  return value === "system" || value === "en" || value === "zh-CN";
}

/**
 * Resolve the effective UI locale.
 *
 * For `system`, the first supported language in the list wins. Any `zh*` tag
 * (including zh-HK / zh-TW) currently maps to Simplified Chinese — Traditional
 * Chinese is not a separate UI locale yet.
 */
export function resolveUiLocale(
  preference: UiLocalePreference,
  systemLanguages: readonly string[]
): UiLocale {
  if (preference !== "system") return preference;
  for (const raw of systemLanguages) {
    const language = raw.toLowerCase();
    if (language === "zh" || language.startsWith("zh-")) return "zh-CN";
    if (language === "en" || language.startsWith("en-")) return "en";
  }
  return "en";
}

export function systemLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length
    ? Array.from(navigator.languages)
    : navigator.language
      ? [navigator.language]
      : [];
}

export function loadUiLocalePreference(): UiLocalePreference {
  if (typeof window === "undefined") return DEFAULT_UI_LOCALE_PREFERENCE;
  try {
    const value = window.localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    if (isUiLocalePreference(value)) return value;
  } catch {
    // Private mode / disabled storage.
  }
  return DEFAULT_UI_LOCALE_PREFERENCE;
}

export function saveUiLocalePreference(preference: UiLocalePreference): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, preference);
  } catch {
    // Private mode / disabled storage.
  }
}

function interpolate(
  template: string,
  params: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token
  );
}

export function translate(
  locale: UiLocale,
  key: MessageKey,
  params: Record<string, string | number> = {}
): string {
  const template = (locale === "zh-CN" ? zhCN : en)[key] ?? en[key];
  return interpolate(template, params);
}

export function localizeRuntimeMessage(
  text: string | null | undefined,
  t: Translate
): string {
  if (!text) return "";
  const key = runtimeMessageKeys[text];
  return key ? t(key) : text;
}

export function formatRelativeTime(
  locale: UiLocale,
  timestamp: number,
  now = Date.now()
): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 45) return formatter.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return formatter.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 14) return formatter.format(-days, "day");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}
