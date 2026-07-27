"use client";

import { useEffect, useRef } from "react";
import { useEditorStore } from "@/lib/store";
import { extractAudio, getFFmpeg } from "@/lib/ffmpeg";
import { useTranscriber } from "@/hooks/useTranscriber";
import TopBar from "./TopBar";
import UploadScreen from "./UploadScreen";
import TranscriptPanel from "./TranscriptPanel";
import MediaPreview from "./MediaPreview";
import Timeline from "./Timeline";
import ExportDialog from "./ExportDialog";

export default function Editor() {
  const status = useEditorStore((s) => s.status);
  const videoFile = useEditorStore((s) => s.videoFile);
  const loadVideo = useEditorStore((s) => s.loadVideo);
  const { transcribe } = useTranscriber();

  // Processing pipeline: load ffmpeg -> extract audio -> transcribe.
  const startedFor = useRef<File | null>(null);
  useEffect(() => {
    if (!videoFile || startedFor.current === videoFile) return;
    startedFor.current = videoFile;
    (async () => {
      const s = useEditorStore.getState();
      try {
        s.setProgress({ message: "Loading media engine…", value: null });
        await getFFmpeg();
        s.setProgress({ message: "Extracting audio…", value: null });
        const audio = await extractAudio(videoFile);
        s.setAudio(audio);
        transcribe(audio, audio.length / 16000);
      } catch (err) {
        console.error("Processing pipeline failed:", err);
        s.setError(err instanceof Error ? err.message : "Failed to process this file.");
      }
    })();
  }, [videoFile, transcribe]);

  // Global shortcuts: space = play/pause, ⌘Z / ⇧⌘Z = undo / redo.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      const s = useEditorStore.getState();
      if (e.code === "Space" && s.videoEl && !s.exportOpen) {
        e.preventDefault();
        if (s.videoEl.paused) void s.videoEl.play();
        else s.videoEl.pause();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-50 text-zinc-900">
      {status === "idle" ? (
        <UploadScreen onFile={loadVideo} />
      ) : (
        <>
          <TopBar />
          <div className="flex min-h-0 flex-1">
            <TranscriptPanel />
            <div className="flex w-[44%] min-w-[320px] shrink-0 flex-col border-l border-zinc-200">
              <MediaPreview />
            </div>
            {/* <SideRail /> — hidden until the tools it exposes are functional */}
          </div>
          <Timeline />
        </>
      )}
      <ExportDialog />
    </div>
  );
}
