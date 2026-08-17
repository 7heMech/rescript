/** User-selected appearance. Defaults to light — does not follow the OS. */
export type Appearance = "light" | "dark";

const APPEARANCE_STORAGE_KEY = "rescript.appearance";

export function isAppearance(value: unknown): value is Appearance {
  return value === "light" || value === "dark";
}

/** Read the stored appearance (defaults to light). */
export function loadAppearance(): Appearance {
  if (typeof window === "undefined") return "light";
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (isAppearance(raw)) return raw;
  } catch {
    /* private mode / blocked storage */
  }
  return "light";
}

export function saveAppearance(appearance: Appearance) {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  } catch {
    /* ignore */
  }
}

/** Toggle the `dark` class on <html> so Tailwind `dark:` utilities apply. */
export function applyAppearance(appearance: Appearance) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", appearance === "dark");
}
