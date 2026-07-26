"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import {
  cutRangeAt,
  formatTime,
  getCutRanges,
  getEditedDuration,
  originalToEdited,
} from "@/lib/edits";

export default function VideoPreview() {
  const videoUrl = useEditorStore((s) => s.videoUrl);
  const words = useEditorStore((s) => s.words);
  const duration = useEditorStore((s) => s.duration);
  const playing = useEditorStore((s) => s.playing);
  const currentTime = useEditorStore((s) => s.currentTime);
  const setVideoEl = useEditorStore((s) => s.setVideoEl);
  const setDuration = useEditorStore((s) => s.setDuration);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cuts = useMemo(() => getCutRanges(words, duration), [words, duration]);
  const cutsRef = useRef(cuts);
  useEffect(() => {
    cutsRef.current = cuts;
  }, [cuts]);

  const editedDuration = useMemo(
    () => getEditedDuration(cuts, duration),
    [cuts, duration]
  );

  const refCb = useCallback(
    (el: HTMLVideoElement | null) => {
      videoRef.current = el;
      setVideoEl(el);
    },
    [setVideoEl]
  );

  // Playback loop: mirror time into the store and skip over cut ranges.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) {
        let t = video.currentTime;
        if (!video.paused) {
          const cut = cutRangeAt(t, cutsRef.current);
          if (cut) {
            const target = cut.end + 0.001;
            if (target >= video.duration - 0.05) {
              video.pause();
              video.currentTime = cut.start;
              t = cut.start;
            } else {
              video.currentTime = target;
              t = target;
            }
          }
        }
        const prev = useEditorStore.getState().currentTime;
        if (Math.abs(prev - t) > 0.005) setCurrentTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setCurrentTime]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // If we're parked inside a cut (or at the end), jump to kept content.
      const cut = cutRangeAt(video.currentTime, cutsRef.current);
      if (cut) video.currentTime = cut.end + 0.001;
      if (video.currentTime >= video.duration - 0.05) video.currentTime = 0;
      void video.play();
    } else {
      video.pause();
    }
  }, []);

  const skip = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), video.duration);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-50/70 p-4">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        {videoUrl && (
          <video
            ref={refCb}
            src={videoUrl}
            playsInline
            onClick={togglePlay}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            className="max-h-full max-w-full cursor-pointer rounded-xl bg-black shadow-lg shadow-zinc-900/10"
          />
        )}
      </div>

      <div className="mt-3 flex shrink-0 items-center justify-center gap-2">
        <span className="mr-2 w-28 text-right text-xs tabular-nums text-zinc-500">
          {formatTime(originalToEdited(currentTime, cuts))}
          <span className="text-zinc-300"> / {formatTime(editedDuration)}</span>
        </span>
        <button
          onClick={() => skip(-5)}
          title="Back 5 s"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition hover:bg-zinc-200"
        >
          <SkipBack size={15} />
        </button>
        <button
          onClick={togglePlay}
          title="Play / pause (space)"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 text-white shadow transition hover:bg-zinc-700"
        >
          {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>
        <button
          onClick={() => skip(5)}
          title="Forward 5 s"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition hover:bg-zinc-200"
        >
          <SkipForward size={15} />
        </button>
        <span className="ml-2 w-28 text-xs tabular-nums text-zinc-400">
          {editedDuration < duration - 0.01 && <>original {formatTime(duration)}</>}
        </span>
      </div>
    </div>
  );
}
