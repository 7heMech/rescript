"use client";

import { useEffect, useState } from "react";

const DARK_MQ = "(prefers-color-scheme: dark)";

/** Tracks the OS color scheme so canvas / imperative paints can match Tailwind `dark:`. */
export function usePrefersDark() {
  const [dark, setDark] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(DARK_MQ).matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia(DARK_MQ);
    const onChange = () => setDark(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}
