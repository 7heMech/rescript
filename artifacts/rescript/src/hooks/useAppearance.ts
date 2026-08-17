
import { useCallback, useState } from "react";
import {
  applyAppearance,
  loadAppearance,
  saveAppearance,
  type Appearance,
} from "@/lib/theme";

/**
 * Appearance preference (default light). Applies the `dark` class on <html>
 * and persists the choice. A blocking boot script in `layout.tsx` prevents FOUC.
 */
export function useAppearance() {
  const [appearance, setAppearanceState] = useState<Appearance>(() => {
    const stored = loadAppearance();
    applyAppearance(stored);
    return stored;
  });

  const setAppearance = useCallback((next: Appearance) => {
    saveAppearance(next);
    applyAppearance(next);
    setAppearanceState(next);
  }, []);

  return { appearance, setAppearance, dark: appearance === "dark" };
}
