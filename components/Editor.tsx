"use client";

import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useEditorStore } from "@/lib/store";
import { extractAudio, getFFmpeg } from "@/lib/ffmpeg";
import { VAD_SAMPLE_RATE } from "@/lib/vad";
import { isElectron } from "@/lib/platform";
import { useIsDesktopLayout } from "@/hooks/useIsDesktopLayout";
import { useTranscriber } from "@/hooks/useTranscriber";
import TopBar from "./TopBar";
import UploadScreen from "./UploadScreen";
import TranscriptPanel from "./TranscriptPanel";
import MediaPreview from "./MediaPreview";
import Timeline from "./Timeline";
import ExportDialog from "./ExportDialog";
import { Download, Redo2, Undo2 } from "lucide-react";
import LogoLoader from "./LogoLoader";
import SettingsMenu from "./SettingsMenu";
import ModelSelector, {
  LanguageSection,
  ModelOption,
  ModelOptionSeparator,
} from "./ModelSelector";
import ImportTranscriptOption from "./ImportTranscriptOption";

/** How long the desktop mode-change overlay stays up. Matches the macOS
 *  `setBounds(..., animate)` duration plus a small buffer so the layout
 *  underneath isn't revealed mid-resize. */
const WINDOW_MODE_OVERLAY_MS = 380;

/** Transcript and preview split, resizable in both orientations. Wide screens
 *  put the transcript first (left of the preview); stacked screens lead with
 *  the preview on top. Each orientation remembers its own sizes. */
function SplitWorkspace({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const horizontal = orientation === "horizontal";
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `editor-workspace-${orientation}`,
    storage: typeof window !== "undefined" ? localStorage : undefined,
  });

  const preview = (
    <Panel
      id="media"
      defaultSize={horizontal ? "44%" : "34vh"}
      minSize={horizontal ? 320 : 140}
      className="flex min-h-0 min-w-0 flex-col"
    >
      <MediaPreview />
    </Panel>
  );
  const transcript = (
    <Panel
      id="transcript"
      defaultSize={horizontal ? "56%" : "66%"}
      minSize={horizontal ? "20%" : 160}
      className="flex min-h-0 min-w-0 flex-col"
    >
      <TranscriptPanel />
    </Panel>
  );
  const separator = (
    <Separator
      className={`${horizontal ? "w-px" : "h-px"} bg-zinc-200 outline-none transition-colors hover:bg-zinc-300 data-[separator=active]:bg-zinc-400 data-[separator=focus]:bg-zinc-400 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:data-[separator=active]:bg-zinc-500 dark:data-[separator=focus]:bg-zinc-500`}
    />
  );

  return (
    <Group
      orientation={orientation}
      className="min-h-0 flex-1"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      // The hairline divider is too small to hit with a finger; widen the
      // touch target well past its visual size.
      resizeTargetMinimumSize={{ coarse: 32, fine: 10 }}
    >
      {horizontal ? (
        <>
          {transcript}
          {separator}
          {preview}
        </>
      ) : (
        <>
          {preview}
          {separator}
          {transcript}
        </>
      )}
    </Group>
  );
}

function EditorWorkspace() {
  const isDesktop = useIsDesktopLayout();
  const mediaKind = useEditorStore((s) => s.mediaKind);
  // Audio has no visual preview — give the transcript the full workspace and
  // mount MediaPreview off-layout so the hidden <audio> element still drives
  // playback / spacebar / timeline controls.
  if (mediaKind === "audio") {
    return (
      <>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TranscriptPanel />
        </div>
        <MediaPreview />
      </>
    );
  }
  // Keyed so crossing the breakpoint remounts the group and restores that
  // orientation's saved layout instead of carrying sizes across.
  return isDesktop ? (
    <SplitWorkspace key="horizontal" orientation="horizontal" />
  ) : (
    <SplitWorkspace key="vertical" orientation="vertical" />
  );
}

export default function Editor() {
  const status = useEditorStore((s) => s.status);
  const videoFile = useEditorStore((s) => s.videoFile);
  const skipTranscription = useEditorStore((s) => s.skipTranscription);
  const loadVideo = useEditorStore((s) => s.loadVideo);
  const { transcribe } = useTranscriber();

  const canUndo = useEditorStore((s) => s.past.length > 0);
  const canRedo = useEditorStore((s) => s.future.length > 0);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const setExportOpen = useEditorStore((s) => s.setExportOpen);

  const [modeTransitioning, setModeTransitioning] = useState(false);
  const wasIdle = useRef(status === "idle");

  // Processing pipeline: load ffmpeg -> extract audio -> (maybe) transcribe.
  // Restored projects already have words; they only need PCM for the waveform.
  const startedFor = useRef<File | null>(null);
  useEffect(() => {
    if (!videoFile || startedFor.current === videoFile) return;
    startedFor.current = videoFile;
    const restoreOnly = useEditorStore.getState().skipTranscription;
    (async () => {
      const s = useEditorStore.getState();
      try {
        s.setProgress({ message: "Loading media engine…", value: null });
        await getFFmpeg();
        s.setProgress({ message: "Extracting audio…", value: null });
        const audio = await extractAudio(videoFile);
        s.setAudio(audio);
        if (restoreOnly || !audio) {
          s.setStatus("ready");
          s.setProgress({ message: "", value: null });
        } else {
          transcribe(audio, audio.length / VAD_SAMPLE_RATE);
        }
      } catch (err) {
        console.error("Processing pipeline failed:", err);
        s.setError(err instanceof Error ? err.message : "Failed to process this file.");
      }
    })();
  }, [videoFile, skipTranscription, transcribe]);

  // The desktop shell opens as a small upload window and grows once the
  // three-pane editor takes over (and shrinks back on "start over").
  // Cover the swap with a brief overlay so the layout reflow isn't visible
  // while the window animates between sizes.
  useEffect(() => {
    const idle = status === "idle";
    window.rescriptDesktop?.setWindowMode(idle ? "compact" : "expanded");
    if (!isElectron || wasIdle.current === idle) return;
    wasIdle.current = idle;
    setModeTransitioning(true);
    const timer = window.setTimeout(() => setModeTransitioning(false), WINDOW_MODE_OVERLAY_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Global shortcuts: space = play/pause, ⌘Z / ⇧⌘Z = undo / redo, S = split.
  // Capture phase so Space is ours before a focused <button> synthesizes a click
  // (which would double-toggle playback and look like the hotkey "didn't work").
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        return;
      const s = useEditorStore.getState();
      if (e.code === "Space" && s.videoEl && !s.exportOpen) {
        e.preventDefault();
        e.stopPropagation();
        s.togglePlayback();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (
        e.key.toLowerCase() === "s" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        s.status === "ready" &&
        !s.exportOpen
      ) {
        e.preventDefault();
        s.splitAtPlayhead();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);

  // Flush pending autosave when the tab hides or unloads.
  useEffect(() => {
    const flush = () => {
      void import("@/lib/autosave").then((m) => m.flushProjectAutosave());
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {status === "idle" ? (
        <>
          {isElectron && <TopBar>
            <ModelSelector groupLabel="Transcript source">
              <ModelOption id="base" />
              <ModelOption id="small" />
              <ModelOptionSeparator />
              <LanguageSection />
              <ModelOptionSeparator />
              <ImportTranscriptOption />
            </ModelSelector>
            <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
            <SettingsMenu />
          </TopBar>}
          <UploadScreen onFile={loadVideo} />
        </>
      ) : (
        <>
          <TopBar>
            <button
              onClick={undo}
              disabled={!canUndo}
              title="Undo (⌘Z)"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <Undo2 size={16} />
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title="Redo (⇧⌘Z)"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <Redo2 size={16} />
            </button>
            <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
            <button
              onClick={() => setExportOpen(true)}
              disabled={status !== "ready" && status !== "exporting"}
              className="flex ml-1 h-8 items-center gap-1.5 rounded-full bg-zinc-900 px-4 text-[13px] font-medium text-white transition hover:bg-zinc-700 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              <Download size={14} />
              Export
            </button>
            <div className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
            <SettingsMenu />
          </TopBar>
          <EditorWorkspace />
          <Timeline />
        </>
      )}
      {modeTransitioning && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-50 dark:bg-zinc-950"
          aria-busy="true"
          aria-live="polite"
        >
          <LogoLoader size={44} />
        </div>
      )}
      <ExportDialog />
    </div>
  );
}
