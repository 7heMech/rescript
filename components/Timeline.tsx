"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize2, SquareSplitHorizontal, Unlink, ZoomIn, ZoomOut } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import {
  canSplitAt,
  formatTime,
  getAdjustedWordCuts,
  getActiveSceneBoundaries,
  getClipSegments,
  getCutRanges,
  getKeepRanges,
  isWordCutOut,
  MIN_CUT_DURATION,
  trimEdgeBounds,
} from "@/lib/edits";
import type { ClipSegment, Word } from "@/lib/types";

const RULER_H = 18;
const WORDBAR_H = 28;
const SAMPLE_RATE = 16000;
const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** Pixels-per-second below which word chips hide (too dense). */
const WORD_VIS_PPS = 22;
/** Pixels-per-second above which edge handles appear on words. */
const HANDLE_VIS_PPS = 40;
const MIN_ZOOM = 1;
const MAX_ZOOM = 256;
/** Wheel-zoom sensitivity (higher = faster zoom per scroll tick). */
const ZOOM_SPEED = 0.0028;
/** Grab width (px) of a cut-edge handle's hit area. */
const CUT_HANDLE_HIT = 14;
/** How close (px) the pointer must be to a split marker to reveal its join button. */
const SPLIT_HOVER_PX = 10;

type DragKind =
  | { type: "seek" }
  | { type: "word"; wordId: number; edge: "start" | "end"; origStart: number; origEnd: number }
  /**
   * `time` tracks where the dragged edge currently sits (mutated as the drag
   * moves); `lo`/`hi` bound it to this clip and the gap next to it, so an edge
   * can close a gap completely but never cross the neighbouring clip's handle.
   */
  | { type: "trim"; edge: "in" | "out"; time: number; lo: number; hi: number }
  | { type: "cut"; key: number; edge: "start" | "end" };

export default function Timeline() {
  const audio = useEditorStore((s) => s.audio);
  const words = useEditorStore((s) => s.words);
  const manualCuts = useEditorStore((s) => s.manualCuts);
  const cutAdjustments = useEditorStore((s) => s.cutAdjustments);
  const sceneBoundaries = useEditorStore((s) => s.sceneBoundaries);
  const duration = useEditorStore((s) => s.duration);
  const currentTime = useEditorStore((s) => s.currentTime);
  const playing = useEditorStore((s) => s.playing);
  const selectedClipIndex = useEditorStore((s) => s.selectedClipIndex);
  const status = useEditorStore((s) => s.status);

  const cuts = useMemo(
    () => getCutRanges(words, duration, manualCuts, cutAdjustments),
    [words, duration, manualCuts, cutAdjustments]
  );
  /** Word-derived cuts (with edge overrides) — source of cut-edge handles. */
  const wordCuts = useMemo(
    () => getAdjustedWordCuts(words, duration, cutAdjustments),
    [words, duration, cutAdjustments]
  );
  const keeps = useMemo(() => getKeepRanges(cuts, duration), [cuts, duration]);
  const clips = useMemo(
    () => getClipSegments(keeps, sceneBoundaries),
    [keeps, sceneBoundaries]
  );
  const splitOk = useMemo(
    () => canSplitAt(currentTime, duration, cuts, sceneBoundaries),
    [currentTime, duration, cuts, sceneBoundaries]
  );
  /** Splits that divide two touching clips — the joinable ones. */
  const splits = useMemo(
    () => getActiveSceneBoundaries(sceneBoundaries, keeps),
    [sceneBoundaries, keeps]
  );

  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragKind | null>(null);
  const [dragType, setDragType] = useState<DragKind["type"] | null>(null);
  const dragging = dragType !== null;
  const [splitFlash, setSplitFlash] = useState(false);

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [hoveredWordId, setHoveredWordId] = useState<number | null>(null);
  const [hoveredClipIndex, setHoveredClipIndex] = useState<number | null>(null);
  /** Index into `cuts` of the skipped region under the pointer, if any. */
  const [hoveredCutIndex, setHoveredCutIndex] = useState<number | null>(null);
  /** Id of the split marker under the pointer, if any. */
  const [hoveredSplitId, setHoveredSplitId] = useState<number | null>(null);

  const fitPps = duration > 0 && width > 0 ? width / duration : 50;
  const pps = fitPps * zoom;
  const totalWidth = Math.max(width, duration * pps);
  const ready = status === "ready" && duration > 0;

  // Live mirrors for imperative wheel/drag handlers (avoid stale closures).
  const ppsRef = useRef(pps);
  const zoomRef = useRef(zoom);
  const widthRef = useRef(width);
  const durationRef = useRef(duration);
  const wordCutsRef = useRef(wordCuts);
  useEffect(() => {
    ppsRef.current = pps;
    zoomRef.current = zoom;
    widthRef.current = width;
    durationRef.current = duration;
    wordCutsRef.current = wordCuts;
  });

  // Scroll position to apply after a wheel-zoom re-renders the track width.
  const pendingScrollRef = useRef<number | null>(null);

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

  // Draw ruler + waveform + cut overlay + clip tint for the visible window.
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

    const trackTop = RULER_H + WORDBAR_H;
    const trackH = height - trackTop;
    const midY = trackTop + trackH / 2;

    // Soft track wash
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, trackTop, width, trackH);

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

    // Wordbar lane background
    ctx.fillStyle = "#f4f4f5";
    ctx.fillRect(0, RULER_H, width, WORDBAR_H);
    ctx.strokeStyle = "#ececef";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + WORDBAR_H - 0.5);
    ctx.lineTo(width, RULER_H + WORDBAR_H - 0.5);
    ctx.stroke();

    if (!audio || duration === 0) return;

    // Clip selection / hover washes on waveform
    for (const clip of clips) {
      const x0 = clip.start * pps - scrollLeft;
      const x1 = clip.end * pps - scrollLeft;
      if (x1 < 0 || x0 > width) continue;
      const selected = clip.index === selectedClipIndex;
      const hovered = clip.index === hoveredClipIndex && !selected;
      if (selected) {
        ctx.fillStyle = "rgba(99, 102, 241, 0.10)";
        ctx.fillRect(x0, trackTop, x1 - x0, trackH);
      } else if (hovered) {
        ctx.fillStyle = "rgba(99, 102, 241, 0.05)";
        ctx.fillRect(x0, trackTop, x1 - x0, trackH);
      }
    }

    // Cut range backgrounds
    for (const cut of cuts) {
      const x0 = cut.start * pps - scrollLeft;
      const x1 = cut.end * pps - scrollLeft;
      if (x1 < 0 || x0 > width) continue;
      ctx.fillStyle = "rgba(254, 226, 226, 0.78)";
      ctx.fillRect(x0, trackTop, x1 - x0, trackH);
      // subtle hatch
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, trackTop, x1 - x0, trackH);
      ctx.clip();
      ctx.strokeStyle = "rgba(252, 165, 165, 0.45)";
      ctx.lineWidth = 1;
      for (let x = x0 - trackH; x < x1 + trackH; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, trackTop);
        ctx.lineTo(x + trackH, trackTop + trackH);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Waveform
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
  }, [
    audio,
    cuts,
    clips,
    duration,
    pps,
    scrollLeft,
    width,
    height,
    selectedClipIndex,
    hoveredClipIndex,
  ]);

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

  // Vertical wheel / pinch zooms (anchored at the pointer); horizontal
  // trackpad side-scroll pans via native overflow-x. Non-passive so zoom
  // can preventDefault.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (durationRef.current <= 0) return;
      // Horizontal intent → pan: don't preventDefault, let native scroll run.
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const curZoom = zoomRef.current;
      const curPps = ppsRef.current;
      if (curPps <= 0) return;
      const rect = el.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const tAnchor = (el.scrollLeft + pointerX) / curPps;
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, curZoom * Math.exp(-e.deltaY * ZOOM_SPEED))
      );
      if (nextZoom === curZoom) return;
      const fit =
        widthRef.current > 0 && durationRef.current > 0
          ? widthRef.current / durationRef.current
          : 50;
      const nextPps = fit * nextZoom;
      pendingScrollRef.current = Math.max(0, tAnchor * nextPps - pointerX);
      setZoom(nextZoom);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Apply the anchor-preserving scroll once wheel-zoom has re-rendered.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || pendingScrollRef.current == null) return;
    el.scrollLeft = pendingScrollRef.current;
    pendingScrollRef.current = null;
    setScrollLeft(el.scrollLeft);
  }, [zoom]);

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return Math.min(
        Math.max(0, (clientX - rect.left + el.scrollLeft) / pps),
        duration
      );
    },
    [pps, duration]
  );

  const seekTo = useCallback((t: number) => {
    const { videoEl, setCurrentTime } = useEditorStore.getState();
    if (videoEl) videoEl.currentTime = t;
    setCurrentTime(t);
  }, []);

  const endDrag = useCallback(() => {
    if (dragRef.current) {
      useEditorStore.getState().endGesture();
      dragRef.current = null;
      setDragType(null);
    }
  }, []);

  useEffect(() => {
    const onUp = () => endDrag();
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [endDrag]);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const t = timeFromClientX(e.clientX);
      // Cut-edge handles only show for the skipped region under the pointer, so
      // track it during drags too (an edge drag keeps the pointer on the region).
      const grab = CUT_HANDLE_HIT / 2 / pps;
      const cutIdx = cuts.findIndex(
        (c) => t >= c.start - grab && t <= c.end + grab
      );
      setHoveredCutIndex(cutIdx === -1 ? null : cutIdx);

      const drag = dragRef.current;
      if (!drag) {
        // Hover clip under cursor (waveform area)
        const clip = clips.find((c) => t >= c.start && t < c.end);
        setHoveredClipIndex(clip?.index ?? null);
        const split = splits.find(
          (b) => Math.abs(t - b.time) * pps <= SPLIT_HOVER_PX
        );
        setHoveredSplitId(split?.id ?? null);
        return;
      }
      setHoveredSplitId(null);
      const store = useEditorStore.getState();

      if (drag.type === "seek") {
        seekTo(t);
        return;
      }
      if (drag.type === "word") {
        if (drag.edge === "start") {
          store.adjustWordBounds(drag.wordId, t, drag.origEnd);
        } else {
          store.adjustWordBounds(drag.wordId, drag.origStart, t);
        }
        return;
      }
      if (drag.type === "trim") {
        const next = Math.min(Math.max(t, drag.lo), drag.hi);
        if (Math.abs(next - drag.time) < 1e-4) return;
        store.trimEdge(drag.edge, drag.time, next);
        drag.time = next;
        return;
      }
      if (drag.type === "cut") {
        const list = wordCutsRef.current;
        const idx = list.findIndex((c) => c.key === drag.key);
        if (idx === -1) return;
        const cut = list[idx];
        const prev = list[idx - 1];
        const next = list[idx + 1];
        let edgeT = t;
        if (drag.edge === "start") {
          const lo = prev ? prev.end : 0;
          const hi = Math.max(lo, cut.end - MIN_CUT_DURATION);
          edgeT = Math.min(Math.max(edgeT, lo), hi);
        } else {
          const hi = next ? next.start : durationRef.current;
          const lo = Math.min(hi, cut.start + MIN_CUT_DURATION);
          edgeT = Math.min(Math.max(edgeT, lo), hi);
        }
        store.adjustCut(drag.key, drag.edge, edgeT);
        // Scrub preview to the edge for precise, audible/visible trimming.
        seekTo(edgeT);
      }
    },
    [clips, cuts, pps, seekTo, splits, timeFromClientX]
  );

  const onPointerLeave = useCallback(() => {
    if (dragRef.current) return;
    setHoveredClipIndex(null);
    setHoveredCutIndex(null);
    setHoveredSplitId(null);
  }, []);

  const joinAtSplit = useCallback((e: ReactPointerEvent | React.MouseEvent, id: number) => {
    e.stopPropagation();
    useEditorStore.getState().removeSceneBoundary(id);
    setHoveredSplitId(null);
  }, []);

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      // Ignore if clicking interactive chrome (handles / chips set their own drag)
      const target = e.target as HTMLElement;
      if (target.closest("[data-tl-interactive]")) return;

      const t = timeFromClientX(e.clientX);
      const clip = clips.find((c) => t >= c.start && t < c.end);
      useEditorStore.getState().setSelectedClipIndex(clip?.index ?? null);
      dragRef.current = { type: "seek" };
      setDragType("seek");
      e.currentTarget.setPointerCapture(e.pointerId);
      seekTo(t);
    },
    [clips, seekTo, timeFromClientX]
  );

  const startWordDrag = useCallback(
    (e: ReactPointerEvent, word: Word, edge: "start" | "end") => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      useEditorStore.getState().beginGesture();
      dragRef.current = {
        type: "word",
        wordId: word.id,
        edge,
        origStart: word.start,
        origEnd: word.end,
      };
      setDragType("word");
    },
    []
  );

  const startTrimDrag = useCallback(
    (e: ReactPointerEvent, clip: ClipSegment, edge: "in" | "out") => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const store = useEditorStore.getState();
      store.setSelectedClipIndex(clip.index);
      store.beginGesture();

      // Reclaiming may consume the whole gap next to this clip, but no further:
      // past that lies the neighbour's own handle, and dragging through it used
      // to trim the wrong clip.
      const { lo, hi } = trimEdgeBounds(clip, edge, cuts);
      dragRef.current = {
        type: "trim",
        edge,
        time: edge === "in" ? clip.start : clip.end,
        lo,
        hi,
      };
      setDragType("trim");
    },
    [cuts]
  );

  const startCutDrag = useCallback(
    (e: ReactPointerEvent, key: number, edge: "start" | "end") => {
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      useEditorStore.getState().beginGesture();
      dragRef.current = { type: "cut", key, edge };
      setDragType("cut");
    },
    []
  );

  const resetCutEdge = useCallback((e: React.MouseEvent, key: number) => {
    e.stopPropagation();
    useEditorStore.getState().resetCutAdjust(key);
  }, []);

  const doSplit = useCallback(() => {
    const ok = useEditorStore.getState().splitAtPlayhead();
    if (!ok) return;
  }, []);

  // Word labels for the visible window
  const visibleWords = useMemo(() => {
    if (pps < WORD_VIS_PPS) return [];
    const t0 = scrollLeft / pps - 1;
    const t1 = (scrollLeft + width) / pps + 1;
    return words.filter((w) => w.end >= t0 && w.start <= t1);
  }, [words, pps, scrollLeft, width]);

  // Cut-edge handles, but only for word-cut edges that are still an edge of the
  // red region they belong to. A blade/trim cut (or a neighbouring cut merging
  // across the gap) can swallow a word-cut whole; its edges then sit *inside* a
  // continuous red block, where they read as stray red bars and dragging them
  // changes nothing visible.
  const cutHandles = useMemo(() => {
    const eps = 1e-4;
    const out: Array<{ key: number; edge: "start" | "end"; time: number }> = [];
    for (const wc of wordCuts) {
      const region = cuts.find(
        (c) => wc.start >= c.start - eps && wc.end <= c.end + eps
      );
      if (!region) continue;
      if (Math.abs(wc.start - region.start) <= eps) {
        out.push({ key: wc.key, edge: "start", time: wc.start });
      }
      if (Math.abs(wc.end - region.end) <= eps) {
        out.push({ key: wc.key, edge: "end", time: wc.end });
      }
    }
    return out;
  }, [wordCuts, cuts]);

  // Show a region's two edge handles only while the pointer is on that region.
  // Rendering every cut's handles all the time left unexplained red bars across
  // the track — a short cut's two edges read as one bold bar at most zooms.
  const visibleCutHandles = useMemo(() => {
    if (dragType !== null && dragType !== "cut") return [];
    const region = hoveredCutIndex === null ? null : cuts[hoveredCutIndex];
    if (!region) return [];
    return cutHandles.filter(
      (h) =>
        Math.abs(h.time - region.start) < 1e-3 || Math.abs(h.time - region.end) < 1e-3
    );
  }, [cutHandles, cuts, dragType, hoveredCutIndex]);

  const playheadX = currentTime * pps - scrollLeft;
  const showHandles = pps >= HANDLE_VIS_PPS;

  return (
    <footer className="flex h-40 shrink-0 flex-col border-t border-zinc-200 bg-white sm:h-52">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-100 px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Timeline
        </span>
        <span className="text-xs tabular-nums text-zinc-400">
          {formatTime(currentTime)}
        </span>

        <div className="mx-auto flex items-center">
          <button
            type="button"
            disabled={!ready || !splitOk}
            onClick={doSplit}
            title={
              splitOk
                ? "Split clip at playhead (S)"
                : "Move the playhead onto a kept region to split"
            }
            className={`group cursor-pointer relative flex h-6 items-center gap-1 rounded-sm px-1 text-xs font-medium transition-all duration-200 ${
              ready && splitOk
                ? "text-black hover:bg-neutral-100 active:scale-[0.97]"
                : "cursor-not-allowed text-zinc-400"
            }`}
          >
            <SquareSplitHorizontal
              size={13}
              className={`transition-transform duration-300`}
            />
            Split
            <kbd
              className={`ml-0.5 rounded px-1 py-px text-[10px] font-normal ${
                ready && splitOk
                  ? "bg-zinc-200/80 text-zinc-800"
                  : "bg-zinc-200/80 text-zinc-400"
              }`}
            >
              S
            </kbd>
          </button>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}
            title="Zoom out"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            title="Fit"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}
            title="Zoom in — drag word edges to refine timing"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      <div ref={outerRef} className="relative min-h-0 flex-1">
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        <div
          ref={scrollRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          className="scrollbar-thin absolute inset-0 touch-none overflow-x-auto overflow-y-hidden select-none"
          style={{ cursor: dragging ? "col-resize" : "default" }}
        >
          <div className="relative h-full" style={{ width: totalWidth }}>
            {/* Split markers between touching clips — hover to reveal "join" */}
            {splits.map((b) => {
              const hovered = hoveredSplitId === b.id;
              return (
                <div
                  key={`split-${b.id}`}
                  className="pointer-events-none absolute z-[8] flex -translate-x-1/2 justify-center"
                  style={{ left: b.time * pps, top: RULER_H, bottom: 0, width: 18 }}
                >
                  <span
                    className={`h-full border-l border-dashed transition-colors ${
                      hovered ? "border-zinc-500" : "border-zinc-300"
                    }`}
                  />
                  {hovered && (
                    <button
                      type="button"
                      data-tl-interactive
                      title="Join these clips (remove split)"
                      aria-label="Join clips"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => joinAtSplit(e, b.id)}
                      className="pointer-events-auto absolute top-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-500 shadow-sm transition hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
                    >
                      <Unlink size={9} />
                    </button>
                  )}
                </div>
              );
            })}

            {/* Cut-edge handles on word-derived cuts (refine ASR bleed) */}
            {visibleCutHandles.map(({ key, edge, time }) => {
              const adjusted = Boolean(cutAdjustments[key]);
              return (
                <div
                  key={`cut-${key}-${edge}`}
                  data-tl-interactive
                  aria-label={`Drag to trim cut ${edge}`}
                  onPointerDown={(e) => startCutDrag(e, key, edge)}
                  onDoubleClick={(e) => resetCutEdge(e, key)}
                  title={
                    adjusted
                      ? `Drag to trim · double-click to reset (cut ${edge})`
                      : `Drag to trim the cut ${edge}`
                  }
                  className="group absolute z-[7] flex touch-none cursor-ew-resize justify-center"
                  style={{
                    left: time * pps - CUT_HANDLE_HIT / 2,
                    top: RULER_H + WORDBAR_H,
                    bottom: 0,
                    width: CUT_HANDLE_HIT,
                  }}
                >
                  <span
                    className={`pointer-events-none h-full w-0.5 rounded-full transition-colors group-hover:w-1 ${
                      adjusted
                        ? "bg-red-500"
                        : "bg-red-400/70 group-hover:bg-red-500"
                    }`}
                  />
                </div>
              );
            })}

            {/* Clip trim handles (selected or hovered) */}
            {clips.map((clip) => {
              const active =
                clip.index === selectedClipIndex || clip.index === hoveredClipIndex;
              if (!active) return null;
              const selected = clip.index === selectedClipIndex;
              return (
                <div key={`trim-${clip.id}`}>
                  <div
                    data-tl-interactive
                    onPointerDown={(e) => startTrimDrag(e, clip, "in")}
                    className="tl-trim-handle absolute z-[6] -translate-x-1/2 cursor-ew-resize"
                    style={{
                      left: clip.start * pps,
                      top: RULER_H + WORDBAR_H + 4,
                      bottom: 4,
                      opacity: selected ? 1 : 0.7,
                    }}
                    title="Trim clip start"
                  >
                    <div
                      className={`h-full w-1 rounded-full transition-all duration-150 ${
                        selected
                          ? "bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,0.2)]"
                          : "bg-indigo-400/80"
                      }`}
                    />
                  </div>
                  <div
                    data-tl-interactive
                    onPointerDown={(e) => startTrimDrag(e, clip, "out")}
                    className="tl-trim-handle absolute z-[6] -translate-x-1/2 cursor-ew-resize"
                    style={{
                      left: clip.end * pps,
                      top: RULER_H + WORDBAR_H + 4,
                      bottom: 4,
                      opacity: selected ? 1 : 0.7,
                    }}
                    title="Trim clip end"
                  >
                    <div
                      className={`h-full w-1 rounded-full transition-all duration-150 ${
                        selected
                          ? "bg-indigo-500 shadow-[0_0_0_3px_rgba(99,102,241,0.2)]"
                          : "bg-indigo-400/80"
                      }`}
                    />
                  </div>
                  {selected && (
                    <div
                      className="pointer-events-none absolute z-[4] rounded-sm ring-1 ring-neutral-400/40"
                      style={{
                        left: clip.start * pps,
                        width: Math.max(2, (clip.end - clip.start) * pps),
                        top: RULER_H + WORDBAR_H + 2,
                        bottom: 2,
                      }}
                    />
                  )}
                </div>
              );
            })}

            {/* Wordbar chips */}
            {visibleWords.map((w) => {
              const wWidth = Math.max(6, (w.end - w.start) * pps - 1);
              const hovered = hoveredWordId === w.id;
              const cutOut = isWordCutOut(w, cuts);
              const showWordHandles = showHandles && (hovered || wWidth > 28);
              return (
                <div
                  key={w.id}
                  data-tl-interactive
                  className={`tl-word absolute z-[3] flex items-center overflow-hidden rounded-md border text-[10px] leading-none transition-[box-shadow,background-color,border-color] duration-150 ${
                    cutOut
                      ? "border-red-200/90 bg-red-50/95 text-red-400 line-through"
                      : hovered
                        ? "border-neutral-300 bg-white text-zinc-700 shadow-sm shadow-neutral-500/10"
                        : "border-zinc-200/90 bg-white/95 text-zinc-600"
                  }`}
                  style={{
                    left: w.start * pps,
                    top: RULER_H + 5,
                    width: wWidth,
                    height: WORDBAR_H - 10,
                  }}
                  title={
                    showHandles
                      ? `${w.text} — drag edges to adjust timing`
                      : w.text
                  }
                  onPointerEnter={() => setHoveredWordId(w.id)}
                  onPointerLeave={() =>
                    setHoveredWordId((id) => (id === w.id ? null : id))
                  }
                  onPointerDown={(e) => {
                    // Clicking the chip body seeks to word start (not a bound drag)
                    if ((e.target as HTMLElement).dataset.edge) return;
                    e.stopPropagation();
                    seekTo(w.start);
                    // Select clip under this word
                    const clip = clips.find(
                      (c) => w.start >= c.start && w.start < c.end
                    );
                    useEditorStore
                      .getState()
                      .setSelectedClipIndex(clip?.index ?? null);
                  }}
                >
                  <span className="pointer-events-none min-w-0 flex-1 truncate px-1.5">
                    {w.text}
                  </span>
                  {showWordHandles && (
                    <>
                      <span
                        data-edge="start"
                        data-tl-interactive
                        onPointerDown={(e) => startWordDrag(e, w, "start")}
                        className="tl-word-handle absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize"
                      >
                        <span
                          className={`absolute inset-y-1 left-0 w-0.5 rounded-full transition-all duration-150 ${
                            cutOut
                              ? "bg-red-400/70"
                              : hovered
                                ? "bg-neutral-500 opacity-100"
                                : "bg-zinc-300 opacity-0 group-hover:opacity-100"
                          }`}
                          style={{ opacity: hovered ? 1 : 0.55 }}
                        />
                      </span>
                      <span
                        data-edge="end"
                        data-tl-interactive
                        onPointerDown={(e) => startWordDrag(e, w, "end")}
                        className="tl-word-handle absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize"
                      >
                        <span
                          className={`absolute inset-y-1 right-0 w-0.5 rounded-full transition-all duration-150 ${
                            cutOut
                              ? "bg-red-400/70"
                              : hovered
                                ? "bg-neutral-500 opacity-100"
                                : "bg-zinc-300 opacity-0 group-hover:opacity-100"
                          }`}
                          style={{ opacity: hovered ? 1 : 0.55 }}
                        />
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {playheadX >= -2 && playheadX <= width + 2 && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-zinc-900/90"
            style={{ transform: `translateX(${playheadX}px)` }}
          >
            <div className="absolute -top-px left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-sm bg-zinc-900 shadow-sm shadow-zinc-900/30 [clip-path:polygon(0_0,100%_0,100%_55%,50%_100%,0_55%)]" />
          </div>
        )}

        {pps < WORD_VIS_PPS && ready && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-full bg-zinc-900/70 px-2.5 py-1 text-[10px] text-white/90 backdrop-blur-sm transition-opacity">
            Zoom in to edit word timing
          </div>
        )}
      </div>
    </footer>
  );
}
