import { en, type DesktopMessageKey } from "./en";
import { zhCN } from "./zh-CN";

export type DesktopLocale = "en" | "zh-CN";

let currentLocale: DesktopLocale = "en";

export function resolveDesktopLocale(value: string): DesktopLocale {
  const locale = value.toLowerCase();
  // Any zh* tag maps to Simplified Chinese until Traditional UI lands.
  return locale === "zh" || locale.startsWith("zh-") ? "zh-CN" : "en";
}

export function setDesktopLocale(locale: DesktopLocale): void {
  currentLocale = locale;
}

export function desktopText(
  key: DesktopMessageKey,
  params: Record<string, string | number> = {}
): string {
  const template = (currentLocale === "zh-CN" ? zhCN : en)[key];
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token
  );
}
