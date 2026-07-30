"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Languages } from "lucide-react";
import {
  TRANSCRIPT_LANGUAGE_ORDER,
  TRANSCRIPT_LANGUAGES,
  type TranscriptLanguage,
} from "@/lib/languages";
import {
  hydrateTranscriptLanguagePreference,
  useEditorStore,
} from "@/lib/store";

export default function LanguageSelector() {
  const language = useEditorStore((s) => s.transcriptLanguage);
  const setLanguage = useEditorStore((s) => s.setTranscriptLanguage);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const active = TRANSCRIPT_LANGUAGES[language];

  useEffect(() => {
    hydrateTranscriptLanguagePreference();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const select = (next: TranscriptLanguage) => {
    setLanguage(next);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title="Transcript language"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-[11rem] cursor-pointer items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-800 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
      >
        <Languages size={14} className="shrink-0 text-zinc-500" />
        <span className="truncate">{active.nativeLabel}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-zinc-400 transition dark:text-zinc-500 ${open ? "rotate-180" : ""}`}
        />
      </button>

      <div
        id={listId}
        role="listbox"
        aria-label="Transcript language"
        hidden={!open}
        className={`absolute right-0 top-[calc(100%+0.5rem)] z-20 w-44 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-lg shadow-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/40 ${
          open ? "" : "pointer-events-none"
        }`}
        style={open ? undefined : { display: "none" }}
      >
        <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
          Language
        </p>
        {TRANSCRIPT_LANGUAGE_ORDER.map((id) => {
          const option = TRANSCRIPT_LANGUAGES[id];
          const selected = id === language;
          return (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => select(id)}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                selected
                  ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
              }`}
            >
              <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight">
                {option.nativeLabel}
              </span>
              {selected && (
                <Check
                  size={14}
                  className="shrink-0 text-zinc-500 dark:text-zinc-300"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
