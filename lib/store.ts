"use client";

import { create } from "zustand";
import type { EditorStatus, ProgressInfo, Word } from "./types";

interface EditorState {
  // Media
  videoFile: File | null;
  videoUrl: string | null;
  duration: number;
  /** Mono 16 kHz PCM of the video's audio track (used for waveform + ASR). */
  audio: Float32Array | null;

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

  // Playback (mirrored from the <video> element for UI rendering)
  currentTime: number;
  playing: boolean;
  videoEl: HTMLVideoElement | null;

  // Export
  exportUrl: string | null;
  exportOpen: boolean;

  // Actions
  loadVideo: (file: File) => void;
  setDuration: (d: number) => void;
  setAudio: (a: Float32Array) => void;
  setStatus: (s: EditorStatus) => void;
  setProgress: (p: ProgressInfo) => void;
  setPartialText: (t: string) => void;
  setError: (message: string) => void;
  setWords: (words: Word[]) => void;
  deleteWords: (ids: number[]) => void;
  restoreWords: (ids: number[]) => void;
  undo: () => void;
  redo: () => void;
  toggleShowDeleted: () => void;
  setCurrentTime: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setVideoEl: (el: HTMLVideoElement | null) => void;
  setExportUrl: (url: string | null) => void;
  setExportOpen: (open: boolean) => void;
  reset: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  videoFile: null,
  videoUrl: null,
  duration: 0,
  audio: null,

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
    const prev = get().videoUrl;
    if (prev) URL.revokeObjectURL(prev);
    set({
      videoFile: file,
      videoUrl: URL.createObjectURL(file),
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
    const { videoUrl, exportUrl } = get();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    set({
      videoFile: null,
      videoUrl: null,
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
