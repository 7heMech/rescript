"use client";

import { useMemo } from "react";
import { getCutRanges } from "@/lib/edits";
import { useEditorStore } from "@/lib/store";

export function useCutRanges() {
  const words = useEditorStore((s) => s.words);
  const manualCuts = useEditorStore((s) => s.manualCuts);
  const duration = useEditorStore((s) => s.duration);
  return useMemo(
    () => getCutRanges(words, duration, manualCuts),
    [words, duration, manualCuts]
  );
}
