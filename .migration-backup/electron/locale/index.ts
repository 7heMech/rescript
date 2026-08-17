import {
  isUiLocale,
  resolveUiLocale,
  type UiLocale,
} from "../../lib/i18n/locales";
import { desktopCatalogs } from "./catalogs";
import type { DesktopMessageKey } from "./en";

export type DesktopLocale = UiLocale;
export type { DesktopMessageKey };

let currentLocale: DesktopLocale = "en";

/** Map Electron's `app.getLocale()` onto a supported desktop UI locale. */
export function resolveDesktopLocale(value: string): DesktopLocale {
  return resolveUiLocale("system", [value]);
}

export function setDesktopLocale(locale: DesktopLocale): void {
  currentLocale = locale;
}

export function isDesktopLocale(value: unknown): value is DesktopLocale {
  return isUiLocale(value);
}

export function desktopText(
  key: DesktopMessageKey,
  params: Record<string, string | number> = {}
): string {
  const template = desktopCatalogs[currentLocale][key] ?? desktopCatalogs.en[key];
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token
  );
}
