import {
  formatRelativeTime,
  localizeRuntimeMessage,
  resolveUiLocale,
  runtimeEnglishMessages,
  runtimeMessageKeys,
  translate,
} from "../lib/i18n";
import { en, type MessageKey } from "../lib/i18n/messages/en";
import { zhCN } from "../lib/i18n/messages/zh-CN";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(resolveUiLocale("system", ["zh-CN"]) === "zh-CN", "zh-CN detection");
assert(resolveUiLocale("system", ["zh-HK"]) === "zh-CN", "zh-HK fallback");
assert(resolveUiLocale("system", ["fr-FR", "en-US"]) === "en", "ordered fallback");
assert(resolveUiLocale("system", ["fr-FR", "zh-Hans"]) === "zh-CN", "secondary zh");
assert(resolveUiLocale("system", []) === "en", "empty fallback");
assert(resolveUiLocale("zh-CN", ["en-US"]) === "zh-CN", "manual zh override");
assert(resolveUiLocale("en", ["zh-CN"]) === "en", "manual en override");

assert(translate("zh-CN", "common.settings") === "设置", "Chinese settings");
assert(translate("en", "common.settings") === "Settings", "English settings");
assert(
  translate("zh-CN", "export.downloadFile", { name: "demo.mp4" }) ===
    "下载 demo.mp4",
  "named interpolation"
);
assert(
  translate("en", "transcript.wordDeleted", { count: 1 }) === "1 word",
  "singular words deleted"
);
assert(
  translate("en", "transcript.wordsDeleted", { count: 3 }) === "3 words",
  "plural words deleted"
);

const zh = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("zh-CN", key, params);
assert(
  localizeRuntimeMessage("Transcribing…", zh) === "正在转录…",
  "runtime progress localization"
);
assert(
  localizeRuntimeMessage("No words to export.", zh) === "没有可导出的文字。",
  "runtime error localization"
);
assert(
  localizeRuntimeMessage(
    'JSON must be a word array or { "words": [...] }.',
    zh
  ) === "JSON 必须是文字数组，或包含 words 字段的对象。",
  "json shape localization"
);
assert(
  localizeRuntimeMessage(
    "Couldn't finish downloading the speech model — the connection dropped. Check your internet and try again; the parts that finished downloading are kept.",
    zh
  ).includes("语音模型"),
  "model download localization"
);
assert(localizeRuntimeMessage("Unknown diagnostic", zh) === "Unknown diagnostic", "fallback");

// Runtime map is derived from the English catalog — every lookup key must match.
for (const english of runtimeEnglishMessages) {
  assert(runtimeMessageKeys[english], `runtime map covers ${english}`);
  const key = runtimeMessageKeys[english];
  assert(en[key] === english, `catalog matches runtime english for ${key}`);
}

// Catalogs stay complete across locales.
const enKeys = Object.keys(en) as MessageKey[];
for (const key of enKeys) {
  assert(typeof zhCN[key] === "string" && zhCN[key].length > 0, `zh-CN has ${key}`);
}

const now = Date.UTC(2026, 7, 9, 12, 0, 0);
assert(formatRelativeTime("zh-CN", now - 5 * 60_000, now).includes("5"), "zh relative");
assert(formatRelativeTime("en", now - 5 * 60_000, now).includes("5"), "en relative");
assert(
  formatRelativeTime("en", now - 10_000, now).toLowerCase().includes("now") ||
    formatRelativeTime("en", now - 10_000, now).includes("second"),
  "en just now"
);

console.log("ALL I18N TESTS PASSED");
