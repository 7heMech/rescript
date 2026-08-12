import { catalogs } from "./catalogs";
import {
  DEFAULT_UI_LOCALE_PREFERENCE,
  UI_LOCALE_STORAGE_KEY,
  isUiLocalePreference,
  type UiLocale,
  type UiLocalePreference,
} from "./locales";
import type { MessageKey } from "./messages/en";
import { runtimeMessageKeys } from "./runtimeMessages";

export type { MessageKey } from "./messages/en";
export {
  runtimeEnglishMessages,
  runtimeMessageKeys,
  type RuntimeMessageKey,
} from "./runtimeMessages";
export {
  DEFAULT_UI_LOCALE,
  DEFAULT_UI_LOCALE_PREFERENCE,
  UI_LOCALES,
  UI_LOCALE_META,
  UI_LOCALE_STORAGE_KEY,
  buildLocaleBootScript,
  isUiLocale,
  isUiLocalePreference,
  matchUiLocale,
  nsisInstallerLanguages,
  resolveUiLocale,
  type UiLocale,
  type UiLocaleMeta,
  type UiLocalePreference,
} from "./locales";

export type Translate = (
  key: MessageKey,
  params?: Record<string, string | number>
) => string;

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
  const template = catalogs[locale][key] ?? catalogs.en[key];
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
