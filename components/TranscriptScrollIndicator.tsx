"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useEditorStore } from "@/lib/store";

/** Height of the transcript's floating header. It covers the top of the
 *  scroller, so the readable area — and its midline — starts below it. */
const HEADER_H = 40;
const MIN_THUMB_H = 28;
/** Kept in sync with the label's `h-3.5` so it can be centred on the thumb. */
const LABEL_H = 14;
/** Candidate spacings between ticks, in seconds, coarsest last. */
const SCROLL_RAIL_TICK_STEPS_S = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const MIN_TICK_GAP = 13;
/** Timestamps land wherever the text puts them, so the gaps between them are
 *  filled with plain ruler ticks at roughly this pitch. */
const MINOR_GAP = 7;
const MAX_SUBDIVISIONS = 6;
/** Matches the ticks' `h-px`. A tick dropped flush with the bottom of the rail
 *  would hang a pixel past the pane and make the whole panel scrollable. */
const TICK_H = 1;
/** How close a tick must be to the thumb to react, and how far it grows. */
const TICK_REACH = 52;
const MAJOR: Emphasis = { minW: 4, maxW: 13, minOpacity: 0.3, maxOpacity: 1 };
const MINOR: Emphasis = { minW: 2, maxW: 6, minOpacity: 0.12, maxOpacity: 0.5 };
/** Idle delay before the ticks and the time label retract again. */
const IDLE_MS = 1000;

/** A measured line of transcript: where it sits, and when it is spoken. */
type Anchor = { top: number; time: number };
type Tick = { time: number; y: number };
/** How a tick reads at rest and when the thumb reaches it. */
type Emphasis = { minW: number; maxW: number; minOpacity: number; maxOpacity: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Grow and brighten ticks as the thumb passes them. */
function emphasize(
  els: (HTMLSpanElement | null)[],
  positions: number[],
  thumbY: number,
  { minW, maxW, minOpacity, maxOpacity }: Emphasis
) {
  const count = Math.min(els.length, positions.length);
  for (let i = 0; i < count; i++) {
    const el = els[i];
    if (!el) continue;
    const distance = Math.abs(positions[i] - thumbY);
    const near = distance > TICK_REACH ? 0 : 1 - distance / TICK_REACH;
    // Smoothstep, so the emphasis eases in instead of ramping linearly.
    const e = near * near * (3 - 2 * near);
    el.style.width = `${minW + (maxW - minW) * e}px`;
    el.style.opacity = `${minOpacity + (maxOpacity - minOpacity) * e}`;
  }
}

/** m:ss (or h:mm past an hour) — no tenths, which only flicker at this size. */
function railTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
  return `${m}:${String(total % 60).padStart(2, "0")}`;
}

/** The scroller and rail measurements every position derives from. */
type Geometry = {
  railH: number;
  viewport: number;
  /** Scrollable distance. */
  range: number;
  thumbH: number;
  /** Distance the thumb's top edge covers, top to bottom. */
  travel: number;
};

/** Null when there is nothing to scroll, and so nothing to indicate. */
function geometryOf(scroller: HTMLElement, railH: number): Geometry | null {
  const viewport = scroller.clientHeight;
  const range = scroller.scrollHeight - viewport;
  if (railH <= 0 || range <= 1) return null;
  const thumbH = Math.max(MIN_THUMB_H, (viewport / scroller.scrollHeight) * railH);
  return { railH, viewport, range, thumbH, travel: railH - thumbH };
}

/** Scroll offset of the pane's midline. The readable area starts below the
 *  header, so its middle sits a little past half the viewport. */
const midline = (viewport: number) => (HEADER_H + viewport) / 2;

/** Rail position for the content at `top`: where the thumb's centre lands once
 *  that content has been scrolled to the middle of the pane. */
function railY(top: number, geometry: Geometry): number {
  const { range, travel, thumbH, viewport } = geometry;
  return ((top - midline(viewport)) / range) * travel + thumbH / 2;
}

/** Media time of the transcript at `top`, interpolated between measured lines. */
function timeAt(anchors: Anchor[], top: number): number {
  if (anchors.length === 0) return 0;
  let lo = 0;
  let hi = anchors.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].top <= top) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const a = anchors[idx];
  const b = anchors[idx + 1];
  if (!b || b.top === a.top) return a.time;
  const k = clamp((top - a.top) / (b.top - a.top), 0, 1);
  return a.time + (b.time - a.time) * k;
}

/**
 * Plain ruler ticks filling the gaps between timestamps at a roughly even
 * pitch. Timestamps land wherever the text puts them, which leaves the rail
 * looking sparse and arbitrary on its own.
 */
function subdivide(majors: number[], limit: number): number[] {
  if (majors.length < 2) return [];
  const stepsIn = (gap: number) => clamp(Math.round(gap / MINOR_GAP), 1, MAX_SUBDIVISIONS);
  const out: number[] = [];
  for (let i = 0; i < majors.length - 1; i++) {
    const gap = majors[i + 1] - majors[i];
    if (gap <= 0) continue;
    const steps = stepsIn(gap);
    for (let k = 1; k < steps; k++) out.push(majors[i] + (gap * k) / steps);
  }
  // Carry the neighbouring pitch past the outermost timestamps so the ruler
  // runs the whole rail instead of stopping short at both ends.
  const head = majors[0];
  const headPitch = (majors[1] - head) / stepsIn(majors[1] - head);
  if (headPitch >= 1) for (let y = head - headPitch; y >= 0; y -= headPitch) out.push(y);
  const tail = majors[majors.length - 1];
  const tailPitch = (tail - majors[majors.length - 2]) / stepsIn(tail - majors[majors.length - 2]);
  if (tailPitch >= 1) for (let y = tail + tailPitch; y <= limit; y += tailPitch) out.push(y);
  return out.sort((a, b) => a - b);
}

/** The inverse of `timeAt`: where `time` falls in scroll coordinates. */
function topAt(anchors: Anchor[], time: number): number {
  if (anchors.length === 0) return 0;
  let lo = 0;
  let hi = anchors.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].time <= time) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const a = anchors[idx];
  const b = anchors[idx + 1];
  if (!b || b.time === a.time) return a.top;
  const k = clamp((time - a.time) / (b.time - a.time), 0, 1);
  return a.top + (b.top - a.top) * k;
}

/**
 * Replaces the transcript's native scrollbar with a rail that reads out the
 * media time of whatever is currently scrolled into view. Ticks mark round
 * timestamps at the position where they appear in the text, so the thumb
 * sweeps past them as those moments reach the top of the pane.
 *
 * Everything that changes per frame (thumb, label, tick emphasis) is written
 * straight to the DOM — a scroll this fast should not re-render the panel.
 */
export default function TranscriptScrollIndicator({
  scrollRef,
  contentRef,
  onUserScroll,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  /** Fired when the user drags or clicks the rail (not programmatic scroll). */
  onUserScroll?: () => void;
}) {
  const words = useEditorStore((s) => s.words);
  const starts = useMemo(() => {
    const map = new Map<number, number>();
    for (const w of words) map.set(w.id, w.start);
    return map;
  }, [words]);

  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const gradientRef = useRef<HTMLDivElement>(null);
  const tickEls = useRef<(HTMLSpanElement | null)[]>([]);
  const minorEls = useRef<(HTMLSpanElement | null)[]>([]);
  const anchors = useRef<Anchor[]>([]);
  const tickPos = useRef<number[]>([]);
  const minorPos = useRef<number[]>([]);
  const dragging = useRef(false);
  const endDrag = useRef<(() => void) | null>(null);
  const hovering = useRef(false);
  const idleTimer = useRef<number | null>(null);

  const [ticks, setTicks] = useState<Tick[]>([]);
  const [minors, setMinors] = useState<number[]>([]);
  const [active, setActive] = useState(false);
  const [enabled, setEnabled] = useState(false);

  const paint = useCallback(() => {
    const scroller = scrollRef.current;
    const rail = railRef.current;
    const thumb = thumbRef.current;
    const label = labelRef.current;
    const gradient = gradientRef.current;
    if (!scroller || !rail || !thumb || !label || !gradient) return;
    const geometry = geometryOf(scroller, rail.clientHeight);
    if (!geometry) return;
    const { railH, viewport, range, thumbH, travel } = geometry;

    const scrollTop = clamp(scroller.scrollTop, 0, range);
    const y = (scrollTop / range) * travel;
    // Ticks and the label read off the thumb's centre, which is the point that
    // tracks the middle of the pane — the text the eye is actually resting on.
    const centre = y + thumbH / 2;

    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translateY(${y}px)`;
    label.style.transform = `translateY(${clamp(centre - LABEL_H / 2, 0, railH - LABEL_H)}px)`;
    label.textContent = railTime(timeAt(anchors.current, scrollTop + midline(viewport)));

    emphasize(tickEls.current, tickPos.current, centre, MAJOR);
    emphasize(minorEls.current, minorPos.current, centre, MINOR);
  }, [scrollRef]);

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const rail = railRef.current;
    if (!scroller || !content || !rail) return;

    // One anchor per rendered line: word spans share an `offsetTop` when they
    // wrap onto the same line, so the first of each line is enough.
    const base = content.offsetTop;
    const measured: Anchor[] = [];
    let lastTop = -1;
    for (const span of content.querySelectorAll<HTMLElement>("[data-wid]")) {
      const top = span.offsetTop;
      if (top === lastTop) continue;
      const time = starts.get(Number(span.dataset.wid));
      if (time === undefined) continue;
      lastTop = top;
      measured.push({ top: base + top, time });
    }
    anchors.current = measured;

    const geometry = geometryOf(scroller, rail.clientHeight);
    const first = measured[0]?.time ?? 0;
    const last = measured[measured.length - 1]?.time ?? 0;
    if (!geometry || measured.length < 2 || last <= first) {
      tickPos.current = [];
      minorPos.current = [];
      setTicks([]);
      setMinors([]);
      setEnabled(false);
      return;
    }

    const { railH, travel } = geometry;
    const spanned = last - first;
    const step =
      SCROLL_RAIL_TICK_STEPS_S.find((s) => (s / spanned) * travel >= MIN_TICK_GAP) ??
      SCROLL_RAIL_TICK_STEPS_S[SCROLL_RAIL_TICK_STEPS_S.length - 1];
    const next: Tick[] = [];
    for (let t = Math.ceil(first / step) * step; t <= last; t += step) {
      const y = railY(topAt(measured, t), geometry);
      // Times that only ever sit above or below the middle of the pane — the
      // opening and closing screenful — have nowhere on the rail to land.
      if (y >= 0 && y <= railH - TICK_H) next.push({ time: t, y });
    }
    const between = subdivide(
      next.map((tick) => tick.y),
      railH - TICK_H
    );
    tickPos.current = next.map((tick) => tick.y);
    minorPos.current = between;
    setTicks(next);
    setMinors(between);
    setEnabled(true);
  }, [scrollRef, contentRef, starts]);

  /** Wake the rail up, and arm the retraction that follows a quiet moment. */
  const bump = useCallback(() => {
    setActive(true);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      idleTimer.current = null;
      if (!dragging.current && !hovering.current) setActive(false);
    }, IDLE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
      endDrag.current?.();
    };
  }, []);

  useEffect(() => {
    measure();
  }, [measure]);

  // Ticks were just (re)rendered, so their elements can take their emphasis.
  useEffect(() => {
    tickEls.current.length = ticks.length;
    minorEls.current.length = minors.length;
    paint();
  }, [ticks, minors, paint]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      bump();
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        paint();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, paint, bump]);

  // Re-measure when the pane resizes or the transcript reflows.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    });
    observer.observe(scroller);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, contentRef, measure]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const scroller = scrollRef.current;
      const rail = railRef.current;
      const thumb = thumbRef.current;
      if (!scroller || !rail || !thumb) return;
      e.preventDefault();

      const railRect = rail.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      // Grabbing the thumb keeps the offset; clicking the rail centres it.
      const grab =
        e.clientY >= thumbRect.top && e.clientY <= thumbRect.bottom
          ? e.clientY - thumbRect.top
          : thumbRect.height / 2;
      const travel = railRect.height - thumbRect.height;
      const range = scroller.scrollHeight - scroller.clientHeight;

      const drag = (clientY: number) => {
        if (travel <= 0) return;
        onUserScroll?.();
        const y = clamp(clientY - railRect.top - grab, 0, travel);
        scroller.scrollTop = (y / travel) * range;
      };
      const onMove = (ev: PointerEvent) => drag(ev.clientY);
      const onUp = () => {
        dragging.current = false;
        endDrag.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        bump();
      };

      dragging.current = true;
      endDrag.current = onUp;
      bump();
      drag(e.clientY);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [scrollRef, bump, onUserScroll]
  );

  return (
    <div
      ref={railRef}
      aria-hidden
      onPointerDown={onPointerDown}
      onPointerEnter={() => {
        hovering.current = true;
        bump();
      }}
      onPointerLeave={() => {
        hovering.current = false;
        bump();
      }}
      className={`absolute top-10 right-0 bottom-0 z-20 w-3 touch-none select-none ${enabled ? "" : "pointer-events-none opacity-0"
        }`}
    >
      {minors.map((y, i) => (
        <span
          key={`minor-${i}`}
          ref={(el) => {
            minorEls.current[i] = el;
          }}
          style={{ top: y, transitionDelay: `${Math.min(i * 4, 160)}ms` }}
          className={`absolute right-2.5 h-px origin-right rounded-full bg-zinc-400 transition-transform duration-300 ease-out dark:bg-zinc-500 ${active ? "scale-x-100" : "scale-x-0"
            }`}
        />
      ))}
      {ticks.map((tick, i) => (
        <span
          key={tick.time}
          ref={(el) => {
            tickEls.current[i] = el;
          }}
          style={{ top: tick.y, transitionDelay: `${Math.min(i * 6, 140)}ms` }}
          className={`absolute right-2.5 h-px origin-right rounded-full bg-zinc-400 transition-transform duration-300 ease-out dark:bg-zinc-500 ${active ? "scale-x-100" : "scale-x-0"
            }`}
        />
      ))}
      {/* Gradient overlay — must match the transcript panel surface */}
      <div ref={gradientRef} className="absolute pointer-events-none right-0 bottom-0 w-12 h-8 bg-gradient-to-t from-white to-transparent dark:from-zinc-900" />
      <div
        ref={thumbRef}
        className={`absolute top-0 right-0.5 w-1 rounded-full transition-colors ${active ? "bg-zinc-400 dark:bg-zinc-500" : "bg-zinc-300 dark:bg-zinc-600"
          }`}
      />
      <span
        ref={labelRef}
        className={`pointer-events-none absolute top-0 right-7 flex h-3.5 items-center text-[10px] font-medium tabular-nums whitespace-nowrap text-zinc-400 transition-opacity duration-200 dark:text-zinc-500 ${active ? "opacity-100" : "opacity-0"
          }`}
      />
    </div>
  );
}
