"use client";

import { create } from "zustand";
import type { EditorStatus, ProgressInfo, Word } from "./types";
import type { ModelChoice } from "./models";
import { detectMediaKind, type MediaKind } from "./media";

interface EditorState {
  // Media
  videoFile: File | null;
  mediaUrl: string | null;
  /** Whether the loaded file is video or audio-only. */
  mediaKind: MediaKind | null;
  duration: number;
  /** Mono 16 kHz PCM of the media's audio track (used for waveform + ASR). */
  audio: Float32Array | null;
  /** Transcription model selected on the upload screen. */
  model: ModelChoice;

  // Pipeline status
  status: EditorStatus;
  progress: ProgressInfo;
  /** Streaming partial transcript text while transcribing. */
  partialText: string;
  error: string | null;

  // Transcript / edits
  words: Word[];
  showDeleted: boolean;
  past: Word[][];
  future: Word[][];

  // Playback (mirrored from the <video>/<audio> element for UI rendering)
  currentTime: number;
  playing: boolean;
  videoEl: HTMLMediaElement | null;

  // Export
  exportUrl: string | null;
  exportOpen: boolean;

  // Actions
  loadVideo: (file: File) => void;
  setModel: (m: ModelChoice) => void;
  setDuration: (d: number) => void;
  setAudio: (a: Float32Array) => void;
  setStatus: (s: EditorStatus) => void;
  setProgress: (p: ProgressInfo) => void;
  setPartialText: (t: string) => void;
  setError: (message: string) => void;
  setWords: (words: Word[]) => void;
  deleteWords: (ids: number[]) => void;
  restoreWords: (ids: number[]) => void;
  /** Replace the selected (contiguous) words with corrected text. */
  correctWords: (ids: number[], text: string) => void;
  undo: () => void;
  redo: () => void;
  toggleShowDeleted: () => void;
  setCurrentTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setVideoEl: (el: HTMLMediaElement | null) => void;
  setExportUrl: (url: string | null) => void;
  setExportOpen: (open: boolean) => void;
  reset: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  videoFile: null,
  mediaUrl: null,
  mediaKind: null,
  duration: 0,
  audio: null,
  model: "base",

  status: "idle",
  progress: { message: "", value: null },
  partialText: "",
  error: null,

  words: [],
  showDeleted: true,
  past: [],
  future: [],

  currentTime: 0,
  playing: false,
  videoEl: null,

  exportUrl: null,
  exportOpen: false,

  loadVideo: (file) => {
    const kind = detectMediaKind(file);
    if (!kind) return;
    const prev = get().mediaUrl;
    if (prev) URL.revokeObjectURL(prev);
    set({
      videoFile: file,
      mediaUrl: URL.createObjectURL(file),
      mediaKind: kind,
      status: "preparing",
      progress: { message: "Loading media engine…", value: null },
      words: [],
      past: [],
      future: [],
      partialText: "",
      error: null,
      currentTime: 0,
      exportUrl: null,
    });
  },
  setModel: (model) => set({ model }),
  setDuration: (duration) => set({ duration }),
  setAudio: (audio) => set({ audio }),
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setPartialText: (partialText) => set({ partialText }),
  setError: (message) => set({ status: "error", error: message }),
  setWords: (words) => set({ words, past: [], future: [] }),

  deleteWords: (ids) => {
    if (ids.length === 0) return;
    const { words, past } = get();
    const idSet = new Set(ids);
    set({
      past: [...past, words],
      future: [],
      words: words.map((w) => (idSet.has(w.id) && !w.deleted ? { ...w, deleted: true } : w)),
    });
  },
  restoreWords: (ids) => {
    if (ids.length === 0) return;
    const { words, past } = get();
    const idSet = new Set(ids);
    set({
      past: [...past, words],
      future: [],
      words: words.map((w) => (idSet.has(w.id) && w.deleted ? { ...w, deleted: false } : w)),
    });
  },
  correctWords: (ids, text) => {
    const { words, past } = get();
    const tokens = text.split(/\s+/).filter(Boolean);
    if (ids.length === 0 || tokens.length === 0) return;
    const idSet = new Set(ids);
    const indices = words.reduce<number[]>((acc, w, i) => {
      if (idSet.has(w.id)) acc.push(i);
      return acc;
    }, []);
    if (indices.length === 0) return;
    // Replace the whole contiguous slice covered by the selection.
    const from = indices[0];
    const to = indices[indices.length - 1];
    const selected = words.slice(from, to + 1);
    if (selected.map((w) => w.text).join(" ") === tokens.join(" ")) return;

    // Distribute the original time span across the new words in proportion
    // to their character length.
    const spanStart = selected[0].start;
    const spanEnd = selected[selected.length - 1].end;
    const span = Math.max(0.02, spanEnd - spanStart);
    const totalChars = tokens.reduce((acc, t) => acc + t.length, 0);
    let nextId = words.reduce((m, w) => Math.max(m, w.id), 0) + 1;
    let cursor = spanStart;
    const replacement: Word[] = tokens.map((t) => {
      const dur = (span * t.length) / totalChars;
      const word: Word = {
        id: nextId++,
        text: t,
        start: cursor,
        end: Math.min(spanEnd, cursor + dur),
        speaker: selected[0].speaker,
        // A correction implies the words are wanted, unless the whole
        // selection was already cut.
        deleted: selected.every((w) => w.deleted),
      };
      cursor = word.end;
      return word;
    });
    replacement[replacement.length - 1].end = spanEnd;

    set({
      past: [...past, words],
      future: [],
      words: [...words.slice(0, from), ...replacement, ...words.slice(to + 1)],
    });
  },
  undo: () => {
    const { past, future, words } = get();
    if (past.length === 0) return;
    set({
      words: past[past.length - 1],
      past: past.slice(0, -1),
      future: [words, ...future],
    });
  },
  redo: () => {
    const { past, future, words } = get();
    if (future.length === 0) return;
    set({
      words: future[0],
      future: future.slice(1),
      past: [...past, words],
    });
  },
  toggleShowDeleted: () => set((s) => ({ showDeleted: !s.showDeleted })),

  setCurrentTime: (currentTime) => set({ currentTime }),
  setPlaying: (playing) => set({ playing }),
  setVideoEl: (videoEl) => set({ videoEl }),
  setExportUrl: (exportUrl) => set({ exportUrl }),
  setExportOpen: (exportOpen) => set({ exportOpen }),

  reset: () => {
    const { mediaUrl, exportUrl } = get();
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    set({
      videoFile: null,
      mediaUrl: null,
      mediaKind: null,
      duration: 0,
      audio: null,
      status: "idle",
      progress: { message: "", value: null },
      partialText: "",
      error: null,
      words: [],
      past: [],
      future: [],
      currentTime: 0,
      playing: false,
      exportUrl: null,
      exportOpen: false,
    });
  },
}));
