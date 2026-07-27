"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { formatTime, getCutRanges } from "@/lib/edits";

const RULER_H = 20;
const LABELS_H = 20;
const SAMPLE_RATE = 16000;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export default function Timeline() {
  const audio = useEditorStore((s) => s.audio);
  const words = useEditorStore((s) => s.words);
  const duration = useEditorStore((s) => s.duration);
  const currentTime = useEditorStore((s) => s.currentTime);
  const playing = useEditorStore((s) => s.playing);

  const cuts = useMemo(() => getCutRanges(words, duration), [words, duration]);

  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(1); // multiplier over "fit"

  const fitPps = duration > 0 && width > 0 ? width / duration : 50;
  const pps = fitPps * zoom;
  const totalWidth = Math.max(width, duration * pps);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw ruler + waveform + cut overlay for the visible window.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const trackTop = RULER_H + LABELS_H;
    const trackH = height - trackTop;
    const midY = trackTop + trackH / 2;

    // Ruler
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "9px ui-sans-serif, system-ui";
    ctx.textBaseline = "top";
    const step = TICK_STEPS.find((s) => s * pps >= 70) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const firstTick = Math.floor(scrollLeft / pps / step) * step;
    for (let t = firstTick; t <= (scrollLeft + width) / pps + step; t += step) {
      const x = t * pps - scrollLeft;
      ctx.fillStyle = "#e4e4e7";
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillStyle = "#a1a1aa";
      ctx.fillText(formatTime(t), x + 4, 3);
    }
    ctx.strokeStyle = "#f0f0f2";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(width, RULER_H - 0.5);
    ctx.stroke();

    if (!audio || duration === 0) return;

    // Cut range backgrounds
    for (const cut of cuts) {
      const x0 = cut.start * pps - scrollLeft;
      const x1 = cut.end * pps - scrollLeft;
      if (x1 < 0 || x0 > width) continue;
      ctx.fillStyle = "rgba(254, 226, 226, 0.85)";
      ctx.fillRect(x0, trackTop, x1 - x0, trackH);
    }

    // Waveform: per-column min/max, sampled with a stride to bound work.
    const samplesPerPx = SAMPLE_RATE / pps;
    const stride = Math.max(1, Math.floor(samplesPerPx / 40));
    for (let x = 0; x < width; x++) {
      const t = (scrollLeft + x) / pps;
      if (t > duration) break;
      const i0 = Math.floor(t * SAMPLE_RATE);
      const i1 = Math.min(audio.length, Math.floor(i0 + samplesPerPx) + 1);
      let min = 0;
      let max = 0;
      for (let i = i0; i < i1; i += stride) {
        const v = audio[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const inCut = cuts.some((c) => t >= c.start && t < c.end);
      ctx.fillStyle = inCut ? "#fca5a5" : "#818cf8";
      const h = Math.max(1, (max - min) * trackH * 0.45);
      ctx.fillRect(x, midY - h / 2, 1, h);
    }
  }, [audio, cuts, duration, pps, scrollLeft, width, height]);

  // Keep the playhead visible while playing.
  useEffect(() => {
    if (!playing) return;
    const el = scrollRef.current;
    if (!el) return;
    const px = currentTime * pps;
    if (px < el.scrollLeft + 24 || px > el.scrollLeft + width - 96) {
      el.scrollLeft = Math.max(0, px - 96);
    }
  }, [currentTime, playing, pps, width]);

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const t = Math.min(
        Math.max(0, (clientX - rect.left + el.scrollLeft) / pps),
        duration
      );
      const { videoEl, setCurrentTime } = useEditorStore.getState();
      if (videoEl) videoEl.currentTime = t;
      setCurrentTime(t);
    },
    [pps, duration]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromPointer(e.clientX);
    },
    [seekFromPointer]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.buttons & 1) seekFromPointer(e.clientX);
    },
    [seekFromPointer]
  );

  // Word labels for the visible window (only when zoomed in enough to read).
  const visibleWords = useMemo(() => {
    if (pps < 18) return [];
    const t0 = scrollLeft / pps - 1;
    const t1 = (scrollLeft + width) / pps + 1;
    return words.filter((w) => w.end >= t0 && w.start <= t1);
  }, [words, pps, scrollLeft, width]);

  const playheadX = currentTime * pps - scrollLeft;

  return (
    <footer className="flex h-44 shrink-0 flex-col border-t border-zinc-200 bg-white">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-100 px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Timeline
        </span>
        <span className="text-xs tabular-nums text-zinc-400">{formatTime(currentTime)}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
            title="Zoom out"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={() => setZoom(1)}
            title="Fit"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <Maximize2 size={13} />
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(256, z * 1.5))}
            title="Zoom in"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      <div ref={outerRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

        <div
          ref={scrollRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          className="scrollbar-thin absolute inset-0 cursor-col-resize touch-none overflow-x-auto overflow-y-hidden select-none"
        >
          <div className="relative h-full" style={{ width: totalWidth }}>
            {visibleWords.map((w) => (
              <span
                key={w.id}
                className={`absolute overflow-hidden text-[10px] whitespace-nowrap ${
                  w.deleted ? "text-red-400 line-through" : "text-zinc-500"
                }`}
                style={{
                  left: w.start * pps + 1,
                  top: RULER_H + 3,
                  maxWidth: Math.max(6, (w.end - w.start) * pps + 24),
                }}
              >
                {w.text}
              </span>
            ))}
          </div>
        </div>

        {playheadX >= 0 && playheadX <= width && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-zinc-900"
            style={{ transform: `translateX(${playheadX}px)` }}
          >
            <div className="absolute -top-px left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-sm bg-zinc-900 [clip-path:polygon(0_0,100%_0,100%_55%,50%_100%,0_55%)]" />
          </div>
        )}
      </div>
    </footer>
  );
}
