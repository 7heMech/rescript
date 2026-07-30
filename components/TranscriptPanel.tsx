"use client";

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  FileText,
  Merge,
  Pencil,
  RotateCcw,
  Scissors,
  WandSparkles,
  X,
} from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { findFillerWordIds } from "@/lib/fillers";
import {
  isTranscriptFile,
  parseTranscriptFile,
  TRANSCRIPT_ACCEPT,
} from "@/lib/parseTranscript";
import type { SpeakerTurn, Word } from "@/lib/types";
import TranscriptScrollIndicator from "./TranscriptScrollIndicator";
import {
  getActiveSceneBoundaries,
  getCutRanges,
  getKeepRanges,
  isWordCutOut,
  mapSplitsToWords,
} from "@/lib/edits";

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
  cutOut,
  active,
  onClick,
}: {
  word: Word;
  /** True when the word is removed from the edited media (deleted or covered by a cut). */
  cutOut: boolean;
  active: boolean;
  onClick: (word: Word, el: HTMLElement) => void;
}) {
  // The trailing space lives inside the span so that selection and deletion
  // highlights are continuous across words instead of breaking at each gap.
  return (
    <span
      data-wid={word.id}
      data-cut={cutOut ? "" : undefined}
      onClick={(e) => onClick(word, e.currentTarget)}
      className={`py-0.5 cursor-pointer transition-colors duration-75 ${cutOut
        ? "word-deleted bg-red-50 text-red-600 line-through decoration-red-300"
        : active
          ? "bg-neutral-200/80 text-zinc-900"
          : "text-zinc-800 hover:bg-neutral-50"
        }`}
    >
      {word.text}{" "}
    </span>
  );
});

/**
 * Descript-style edit boundary: the "|" between two clips created by a split.
 * Click it to join them back together (the inverse of Split / S).
 */
const SplitMarker = memo(function SplitMarker({
  boundaryId,
  onJoin,
}: {
  boundaryId: number;
  onJoin: (id: number) => void;
}) {
  return (
    <button
      type="button"
      title="Clip split — click to join these clips"
      aria-label="Join clips"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onJoin(boundaryId)}
      className="group relative mx-0.5 inline-flex h-4 w-2 cursor-pointer select-none items-center justify-center align-middle"
    >
      <span className="h-4 w-0.5 rounded-full bg-zinc-300 transition-colors group-hover:bg-zinc-600" />
      <span className="pointer-events-none absolute -top-5 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
        <Merge size={9} />
        Join
      </span>
    </button>
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
  const manualCuts = useEditorStore((s) => s.manualCuts);
  const sceneBoundaries = useEditorStore((s) => s.sceneBoundaries);
  const duration = useEditorStore((s) => s.duration);
  const status = useEditorStore((s) => s.status);
  const progress = useEditorStore((s) => s.progress);
  const partialText = useEditorStore((s) => s.partialText);
  const error = useEditorStore((s) => s.error);
  const showDeleted = useEditorStore((s) => s.showDeleted);
  const toggleShowDeleted = useEditorStore((s) => s.toggleShowDeleted);
  const deleteWords = useEditorStore((s) => s.deleteWords);
  const restoreWords = useEditorStore((s) => s.restoreWords);
  const correctWords = useEditorStore((s) => s.correctWords);
  const importWords = useEditorStore((s) => s.importWords);
  const removeSceneBoundary = useEditorStore((s) => s.removeSceneBoundary);
  const selectedWordIds = useEditorStore((s) => s.selectedWordIds);
  const setSelectedWords = useEditorStore((s) => s.setSelectedWords);
  const playing = useEditorStore((s) => s.playing);
  const activeWordId = useEditorStore((s) => findActiveWordId(s.words, s.currentTime));

  const cuts = useMemo(
    () => getCutRanges(words, duration, manualCuts),
    [words, duration, manualCuts]
  );
  const cutOutIds = useMemo(() => {
    const ids = new Set<number>();
    for (const w of words) {
      if (isWordCutOut(w, cuts)) ids.add(w.id);
    }
    return ids;
  }, [words, cuts]);

  // Splits get a joinable edit boundary in the transcript, like the timeline's
  // marker. Splits at the edge of a skipped region are inert and hidden in both.
  const splitBeforeWordId = useMemo(
    () =>
      mapSplitsToWords(
        words,
        getActiveSceneBoundaries(sceneBoundaries, getKeepRanges(cuts, duration))
      ),
    [sceneBoundaries, cuts, duration, words]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [correcting, setCorrecting] = useState<{
    ids: number[];
    top: number;
    left: number;
    containerWidth: number;
  } | null>(null);
  const [correctText, setCorrectText] = useState("");
  // Mirrors `correcting` so the selectionchange handler (which has its own
  // dependency list) can freeze the highlight while the popover is open.
  const correctingRef = useRef(false);

  const turns = useMemo<SpeakerTurn[]>(() => {
    const out: SpeakerTurn[] = [];
    for (const w of words) {
      const last = out[out.length - 1];
      if (last && last.speaker === w.speaker) last.words.push(w);
      else out.push({ speaker: w.speaker, words: [w] });
    }
    return out;
  }, [words]);

  const deletedCount = useMemo(() => cutOutIds.size, [cutOutIds]);
  const fillerIds = useMemo(() => findFillerWordIds(words), [words]);

  const removeFillers = useCallback(() => {
    deleteWords(fillerIds);
  }, [deleteWords, fillerIds]);

  const handleImportTranscript = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (!isTranscriptFile(file)) {
        alert("Please choose an SRT, VTT, or JSON transcript.");
        return;
      }
      if (
        words.length > 0 &&
        !confirm("Replace the current transcript with this file?")
      ) {
        return;
      }
      try {
        const imported = await parseTranscriptFile(file);
        importWords(imported);
      } catch (err) {
        console.error(err);
        alert(err instanceof Error ? err.message : "Could not read that transcript.");
      }
    },
    [words.length, importWords]
  );

  const joinSplit = useCallback(
    (id: number) => {
      removeSceneBoundary(id);
    },
    [removeSceneBoundary]
  );

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
  // True while the current selection came from clicking a single word. There is
  // no native range in that case, so the collapsed-selection branch of the
  // selectionchange handler must not wipe it.
  const clickSelectionRef = useRef(false);

  const clearMarks = useCallback(() => {
    for (const el of markedRef.current) el.removeAttribute("data-sel");
    markedRef.current.clear();
  }, []);

  const clearSelection = useCallback(() => {
    clearMarks();
    clickSelectionRef.current = false;
    setSelection(null);
    setSelectedWords([]);
    window.getSelection()?.removeAllRanges();
  }, [clearMarks, setSelectedWords]);

  // Clicking a word seeks to it and selects it, so the toolbar and the
  // Delete/Backspace shortcut work on single words too — not just drags.
  const handleWordClick = useCallback(
    (word: Word, el: HTMLElement) => {
      const nativeSel = window.getSelection();
      // A drag ends with a click on the word under the cursor; leave the
      // range-based selection (and the playhead) alone in that case.
      if (nativeSel && !nativeSel.isCollapsed) return;
      seekToWord(word);
      const container = containerRef.current;
      if (!container) return;
      clearMarks();
      el.setAttribute("data-sel", "");
      markedRef.current.add(el);
      clickSelectionRef.current = true;
      const rect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const cutOut = cutOutIds.has(word.id);
      setSelection({
        ids: [word.id],
        anyDeleted: cutOut,
        anyKept: !cutOut,
        top: rect.top - containerRect.top - 44,
        left: Math.max(8, rect.left - containerRect.left + rect.width / 2),
      });
      setSelectedWords([word.id]);
    },
    [seekToWord, clearMarks, cutOutIds, setSelectedWords]
  );

  useEffect(() => {
    const handler = () => {
      // Keep the highlight frozen on the words being corrected.
      if (correctingRef.current) return;
      const container = containerRef.current;
      const sel = window.getSelection();
      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        // A click collapses the native selection; that must not clear the
        // single-word selection the click itself is about to create.
        if (clickSelectionRef.current) return;
        clearMarks();
        setSelection(null);
        setSelectedWords([]);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        if (clickSelectionRef.current) return;
        clearMarks();
        setSelection(null);
        setSelectedWords([]);
        return;
      }
      clickSelectionRef.current = false;
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
          if (w && cutOutIds.has(w.id)) anyDeleted = true;
          else anyKept = true;
        }
      });
      for (const el of markedRef.current) {
        if (!marked.has(el)) el.removeAttribute("data-sel");
      }
      markedRef.current = marked;
      if (ids.length === 0) {
        setSelection(null);
        setSelectedWords([]);
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
      setSelectedWords(ids);
    };
    document.addEventListener("selectionchange", handler);
    return () => {
      // A click selection has no native range to track, so keep its highlight
      // across the re-subscriptions this effect goes through.
      if (!clickSelectionRef.current) clearMarks();
      document.removeEventListener("selectionchange", handler);
    };
  }, [words, cutOutIds, clearMarks, setSelectedWords]);

  // A click-based selection has no native range, so nothing else would drop it:
  // clear it when the next mousedown lands outside the words and the toolbar.
  // Only presses inside this panel count — the timeline owns its own clearing,
  // and clicking a word chip there must not wipe the selection it just made.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!clickSelectionRef.current || correctingRef.current) return;
      const target = e.target as HTMLElement | null;
      if (!target || !scrollRef.current?.contains(target)) return;
      if (target.closest("[data-wid], [data-transcript-toolbar]")) return;
      clearSelection();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [clearSelection]);

  // Mirror a selection made elsewhere (the timeline wordbar) into this panel:
  // highlight the words, scroll them into view and place the toolbar. Selections
  // that originated here already match, so this is a no-op for them.
  useEffect(() => {
    if (correctingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const shown = selection?.ids ?? [];
    if (
      shown.length === selectedWordIds.length &&
      shown.every((id, i) => id === selectedWordIds[i])
    ) {
      return;
    }
    const els = selectedWordIds
      .map((id) => container.querySelector<HTMLElement>(`[data-wid="${id}"]`))
      .filter((el): el is HTMLElement => el !== null);
    clearMarks();
    if (els.length === 0) {
      clickSelectionRef.current = false;
      setSelection(null);
      return;
    }
    for (const el of els) {
      el.setAttribute("data-sel", "");
      markedRef.current.add(el);
    }
    clickSelectionRef.current = true;
    els[0].scrollIntoView({ block: "nearest" });
    const rect = els[0].getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setSelection({
      ids: selectedWordIds,
      anyDeleted: selectedWordIds.some((id) => cutOutIds.has(id)),
      anyKept: selectedWordIds.some((id) => !cutOutIds.has(id)),
      top: rect.top - containerRect.top - 44,
      left: Math.max(8, rect.left - containerRect.left + rect.width / 2),
    });
  }, [selectedWordIds, selection, cutOutIds, clearMarks]);

  const cutSelection = useCallback(() => {
    if (!selection) return;
    deleteWords(selection.ids);
    clearSelection();
  }, [selection, deleteWords, clearSelection]);

  const restoreSelection = useCallback(() => {
    if (!selection) return;
    restoreWords(selection.ids);
    clearSelection();
  }, [selection, restoreWords, clearSelection]);

  const openCorrect = useCallback(() => {
    if (!selection) return;
    const idSet = new Set(selection.ids);
    const text = words
      .filter((w) => idSet.has(w.id))
      .map((w) => w.text)
      .join(" ");
    correctingRef.current = true;
    clickSelectionRef.current = false;
    setCorrectText(text);
    setCorrecting({
      ids: selection.ids,
      top: selection.top,
      left: selection.left,
      containerWidth: containerRef.current?.clientWidth ?? 640,
    });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [selection, words]);

  const closeCorrect = useCallback(() => {
    correctingRef.current = false;
    for (const el of markedRef.current) el.removeAttribute("data-sel");
    markedRef.current.clear();
    setCorrecting(null);
  }, []);

  const applyCorrection = useCallback(() => {
    if (!correcting) return;
    correctWords(correcting.ids, correctText);
    closeCorrect();
  }, [correcting, correctText, correctWords, closeCorrect]);

  // Close the correction popover when clicking outside of it.
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!correcting) return;
    const handler = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) closeCorrect();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [correcting, closeCorrect]);

  // Delete / Backspace cuts the selected words. Driven by the shared selection so
  // it works for words picked in the timeline wordbar too.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace" && e.key !== "Escape") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      if (selectedWordIds.length === 0) return;
      e.preventDefault();
      if (e.key !== "Escape") deleteWords(selectedWordIds);
      clearSelection();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedWordIds, deleteWords, clearSelection]);

  // Keep the active word in view during playback.
  useEffect(() => {
    if (!playing || activeWordId < 0) return;
    const el = containerRef.current?.querySelector(`[data-wid="${activeWordId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeWordId, playing]);

  const busy = status === "preparing" || status === "transcribing";

  return (
    // min-h-0 keeps this pane from growing to the transcript's full height —
    // without it the panel wrapper scrolls instead of the list below.
    <section className="relative flex min-h-0 min-w-0 overflow-y-hidden flex-1 flex-col bg-white">
      {/* Floats above the scroller rather than sticking inside it, so the
          rubber-band overscroll only carries the transcript, not the bar. */}
      <div className="absolute inset-x-0 top-0 z-10 flex h-10 items-center gap-2 border-b border-zinc-100/80 bg-white/75 px-3 backdrop-blur-md sm:px-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Transcript
        </span>
        <div className="ml-auto flex items-center gap-2">
          {deletedCount > 0 && (
            <span className="rounded-md bg-red-50 px-2 py-0.5 text-[9px] font-medium text-red-600 line-clamp-1 line-through">
              {deletedCount} word{deletedCount === 1 ? "" : "s"}
            </span>
          )}
          {status === "ready" && fillerIds.length > 0 && (
            <button
              onClick={removeFillers}
              title='Cut filler words ("um", "uh", …) from the video'
              className="flex cursor-pointer h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100 line-clamp-1"
            >
              <WandSparkles size={14} />
              <span className="hidden sm:inline">Remove filler words ({fillerIds.length})</span>
            </button>
          )}
          {(status === "ready" || status === "error" || status === "transcribing") && (
            <>
              <button
                onClick={() => importInputRef.current?.click()}
                title="Replace transcript from SRT, VTT, or JSON"
                className="flex cursor-pointer h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
              >
                <FileText size={14} />
                <span className="hidden sm:inline">Import</span>
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept={TRANSCRIPT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  e.target.value = "";
                  void handleImportTranscript(files);
                }}
              />
            </>
          )}
          <button
            onClick={toggleShowDeleted}
            title={showDeleted ? "Hide deleted words" : "Show deleted words"}
            className="flex cursor-pointer h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-zinc-500 transition hover:bg-zinc-100"
          >
            {showDeleted ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="scrollbar-none relative min-h-0 flex-1 overflow-y-auto pt-10 scroll-pt-10"
      >
        <div ref={containerRef} className="relative mx-auto max-w-2xl px-4 py-6 sm:px-8 sm:py-8">
          {busy && (
            <div className="flex flex-col items-start gap-4">
              <div className="w-full bg-zinc-50 p-2">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent" />
                  <p className="text-sm font-medium text-zinc-700">{progress.message}</p>
                  {progress.value !== null && (
                    <>
                      <div className="ml-auto w-[100px] h-1 overflow-hidden rounded-full bg-zinc-200">
                        <div
                          className="h-full rounded-full bg-neutral-500 transition-[width] duration-300"
                          style={{ width: `${progress.value * 100}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-zinc-400">
                        {Math.round(progress.value * 100)}%
                      </span>
                    </>
                  )}
                </div>
              </div>
              {partialText && (
                <p className="text-[15px] leading-8 text-zinc-400">
                  {partialText}
                  <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-neutral-500 align-middle" />
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
                const visible = showDeleted
                  ? turn.words
                  : turn.words.filter((w) => !cutOutIds.has(w.id));
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
                      {visible.map((w) => {
                        const split = splitBeforeWordId.get(w.id);
                        return (
                          <React.Fragment key={w.id}>
                            {split && (
                              <SplitMarker boundaryId={split.id} onJoin={joinSplit} />
                            )}
                            <WordSpan
                              word={w}
                              cutOut={cutOutIds.has(w.id)}
                              active={w.id === activeWordId}
                              onClick={handleWordClick}
                            />
                          </React.Fragment>
                        );
                      })}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {selection && !correcting && (
            <div
              data-transcript-toolbar
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
              <button
                onClick={openCorrect}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-zinc-700 transition hover:bg-zinc-100"
              >
                <Pencil size={13} />
                Correct
              </button>
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

          {correcting && (
            <div
              ref={popoverRef}
              className="absolute z-20 w-80 max-w-[calc(100%-16px)] -translate-x-1/2 rounded-2xl border border-zinc-200 bg-white p-3 shadow-xl shadow-zinc-900/10"
              style={{
                top: Math.max(4, correcting.top - 56),
                left: Math.min(
                  Math.max(168, correcting.left),
                  correcting.containerWidth - 168
                ),
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-zinc-800">Correct</span>
                <button
                  onClick={closeCorrect}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
                >
                  <X size={13} />
                </button>
              </div>
              <input
                autoFocus
                value={correctText}
                onChange={(e) => setCorrectText(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCorrection();
                  else if (e.key === "Escape") closeCorrect();
                }}
                className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-2.5 py-1.5 text-sm text-zinc-800 outline-none focus:border-zinc-500 focus:bg-white"
              />
              <div className="mt-2.5 flex justify-end">
                <button
                  onClick={applyCorrection}
                  disabled={correctText.trim().length === 0}
                  className="flex h-8 items-center rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition hover:bg-zinc-700 disabled:opacity-40"
                >
                  Correct
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Gradient overlay */}
      <div className="absolute z-10 pointer-events-none inset-x-0 bottom-0 w-full h-20 bg-gradient-to-t from-white to-transparent" />
      <TranscriptScrollIndicator scrollRef={scrollRef} contentRef={containerRef} />
    </section>
  );
}
