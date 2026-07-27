"use client";

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, RotateCcw, Scissors } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import type { SpeakerTurn, Word } from "@/lib/types";

export const SPEAKER_COLORS = [
  "#16a34a", // green
  "#2563eb", // blue
  "#9333ea", // purple
  "#ea580c", // orange
  "#0d9488", // teal
  "#db2777", // pink
];

export const speakerColor = (i: number) =>
  SPEAKER_COLORS[Math.max(0, i) % SPEAKER_COLORS.length];

function findActiveWordId(words: Word[], t: number): number {
  // Binary search for the last word starting at or before t.
  let lo = 0;
  let hi = words.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx >= 0 && t < words[idx].end + 0.15) return words[idx].id;
  return -1;
}

const WordSpan = memo(function WordSpan({
  word,
  active,
  onClick,
}: {
  word: Word;
  active: boolean;
  onClick: (word: Word) => void;
}) {
  // The trailing space lives inside the span so that selection and deletion
  // highlights are continuous across words instead of breaking at each gap.
  return (
    <span
      data-wid={word.id}
      onClick={() => onClick(word)}
      className={`cursor-pointer transition-colors duration-75 ${
        word.deleted
          ? "word-deleted bg-red-50 text-red-400 line-through decoration-red-300"
          : active
            ? "bg-indigo-200/80 text-zinc-900"
            : "text-zinc-800 hover:bg-indigo-50"
      }`}
    >
      {word.text}{" "}
    </span>
  );
});

interface SelectionInfo {
  ids: number[];
  anyDeleted: boolean;
  anyKept: boolean;
  top: number;
  left: number;
}

export default function TranscriptPanel() {
  const words = useEditorStore((s) => s.words);
  const status = useEditorStore((s) => s.status);
  const progress = useEditorStore((s) => s.progress);
  const partialText = useEditorStore((s) => s.partialText);
  const error = useEditorStore((s) => s.error);
  const showDeleted = useEditorStore((s) => s.showDeleted);
  const toggleShowDeleted = useEditorStore((s) => s.toggleShowDeleted);
  const deleteWords = useEditorStore((s) => s.deleteWords);
  const restoreWords = useEditorStore((s) => s.restoreWords);
  const playing = useEditorStore((s) => s.playing);
  const activeWordId = useEditorStore((s) => findActiveWordId(s.words, s.currentTime));

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);

  const turns = useMemo<SpeakerTurn[]>(() => {
    const out: SpeakerTurn[] = [];
    for (const w of words) {
      const last = out[out.length - 1];
      if (last && last.speaker === w.speaker) last.words.push(w);
      else out.push({ speaker: w.speaker, words: [w] });
    }
    return out;
  }, [words]);

  const deletedCount = useMemo(() => words.filter((w) => w.deleted).length, [words]);

  const seekToWord = useCallback((word: Word) => {
    const { videoEl, setCurrentTime } = useEditorStore.getState();
    if (videoEl) videoEl.currentTime = word.start + 0.001;
    setCurrentTime(word.start + 0.001);
  }, []);

  // Track text selection over word spans, position the floating toolbar, and
  // paint our own (dimmed, gap-free) highlight by marking the selected spans.
  // The native ::selection highlight is made transparent over the words, and
  // the marking is done imperatively so dragging doesn't re-render the panel.
  const markedRef = useRef<Set<HTMLElement>>(new Set());
  useEffect(() => {
    const clearMarks = () => {
      for (const el of markedRef.current) el.removeAttribute("data-sel");
      markedRef.current.clear();
    };
    const handler = () => {
      const container = containerRef.current;
      const sel = window.getSelection();
      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        clearMarks();
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        clearMarks();
        setSelection(null);
        return;
      }
      const wordMap = new Map(words.map((w) => [w.id, w]));
      const ids: number[] = [];
      let anyDeleted = false;
      let anyKept = false;
      const marked = new Set<HTMLElement>();
      container.querySelectorAll<HTMLElement>("[data-wid]").forEach((el) => {
        if (range.intersectsNode(el)) {
          const id = Number(el.dataset.wid);
          ids.push(id);
          el.setAttribute("data-sel", "");
          marked.add(el);
          const w = wordMap.get(id);
          if (w?.deleted) anyDeleted = true;
          else anyKept = true;
        }
      });
      for (const el of markedRef.current) {
        if (!marked.has(el)) el.removeAttribute("data-sel");
      }
      markedRef.current = marked;
      if (ids.length === 0) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setSelection({
        ids,
        anyDeleted,
        anyKept,
        top: rect.top - containerRect.top - 44,
        left: Math.max(8, rect.left - containerRect.left + rect.width / 2),
      });
    };
    document.addEventListener("selectionchange", handler);
    return () => {
      clearMarks();
      document.removeEventListener("selectionchange", handler);
    };
  }, [words]);

  const cutSelection = useCallback(() => {
    if (!selection) return;
    deleteWords(selection.ids);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, [selection, deleteWords]);

  const restoreSelection = useCallback(() => {
    if (!selection) return;
    restoreWords(selection.ids);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, [selection, restoreWords]);

  // Delete / Backspace cuts the selected words.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      if (!selection || selection.ids.length === 0) return;
      e.preventDefault();
      cutSelection();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selection, cutSelection]);

  // Keep the active word in view during playback.
  useEffect(() => {
    if (!playing || activeWordId < 0) return;
    const el = containerRef.current?.querySelector(`[data-wid="${activeWordId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeWordId, playing]);

  const busy = status === "preparing" || status === "transcribing";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-100 px-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Transcript
        </span>
        {status === "ready" && (
          <span className="hidden text-xs text-zinc-400 md:inline">
            · select words and press ⌫ to cut
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {deletedCount > 0 && (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-500">
              {deletedCount} word{deletedCount === 1 ? "" : "s"} cut
            </span>
          )}
          <button
            onClick={toggleShowDeleted}
            title={showDeleted ? "Hide deleted words" : "Show deleted words"}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
          >
            {showDeleted ? <Eye size={14} /> : <EyeOff size={14} />}
            {showDeleted ? "Showing cuts" : "Hiding cuts"}
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div ref={containerRef} className="relative mx-auto max-w-2xl px-8 py-8">
          {busy && (
            <div className="flex flex-col items-start gap-4">
              <div className="w-full rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                <div className="flex items-center gap-3">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
                  <p className="text-sm font-medium text-zinc-700">{progress.message}</p>
                  {progress.value !== null && (
                    <span className="ml-auto text-xs tabular-nums text-zinc-400">
                      {Math.round(progress.value * 100)}%
                    </span>
                  )}
                </div>
                {progress.value !== null && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-200">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-[width] duration-300"
                      style={{ width: `${progress.value * 100}%` }}
                    />
                  </div>
                )}
              </div>
              {partialText && (
                <p className="text-[15px] leading-8 text-zinc-400">
                  {partialText}
                  <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-indigo-500 align-middle" />
                </p>
              )}
            </div>
          )}

          {status === "error" && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          {status === "ready" && (
            <div className="transcript-words selection:bg-transparent">
              {turns.map((turn, i) => {
                const visible = showDeleted ? turn.words : turn.words.filter((w) => !w.deleted);
                if (visible.length === 0) return null;
                return (
                  <div key={i} className="mb-7">
                    <div
                      className="mb-1.5 text-[13px] font-semibold"
                      style={{ color: speakerColor(turn.speaker) }}
                    >
                      Speaker {turn.speaker + 1}
                    </div>
                    <p className="select-text text-[15px] leading-8">
                      {visible.map((w) => (
                        <WordSpan
                          key={w.id}
                          word={w}
                          active={w.id === activeWordId}
                          onClick={seekToWord}
                        />
                      ))}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {selection && (
            <div
              className="absolute z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-zinc-200 bg-white p-1 shadow-lg shadow-zinc-900/10"
              style={{ top: selection.top, left: selection.left }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {selection.anyKept && (
                <button
                  onClick={cutSelection}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-red-50 hover:text-red-600"
                >
                  <Scissors size={13} />
                  Cut
                </button>
              )}
              {selection.anyDeleted && (
                <button
                  onClick={restoreSelection}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-emerald-50 hover:text-emerald-600"
                >
                  <RotateCcw size={13} />
                  Restore
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
