"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useEditorStore } from "@/lib/store";
import { findActiveWordId } from "@/lib/transcript";

/** Matches the transcript panel's floating header (`h-10` / `pt-10` / `scroll-pt-10`). */
const HEADER_H = 40;

export type FollowDirection = "up" | "down";

/**
 * Keep the active transcript word in view during playback, but pause when the
 * user scrolls it offscreen. Exposes a Follow control until they resume.
 */
export function useTranscriptPlayheadFollow({
  scrollRef,
  containerRef,
  playing,
  activeWordId,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  playing: boolean;
  activeWordId: number;
}) {
  const followPlayheadRef = useRef(true);
  /** Set by wheel/touch/rail before the matching scroll event. */
  const userScrollGestureRef = useRef(false);
  const userScrollGestureTimerRef = useRef(0);
  const [followPlayhead, setFollowPlayhead] = useState(true);
  /** Playhead outside the readable viewport — gates the Follow control. */
  const [playheadOffscreen, setPlayheadOffscreen] = useState(false);
  /** Which way to jump to the playhead when unfollowed. */
  const [followDirection, setFollowDirection] =
    useState<FollowDirection>("down");

  /** Measure whether the active word sits above/below the readable pane. */
  const measurePlayheadAnchor = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return { offscreen: false as const };
    const { words, currentTime } = useEditorStore.getState();
    const activeId = findActiveWordId(words, currentTime);
    if (activeId < 0) {
      setPlayheadOffscreen(false);
      return { offscreen: false as const };
    }
    const el = containerRef.current?.querySelector(`[data-wid="${activeId}"]`);
    if (!el) {
      setPlayheadOffscreen(false);
      return { offscreen: false as const };
    }
    const wordRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const viewTop = scrollerRect.top + HEADER_H;
    const viewBottom = scrollerRect.bottom;
    if (wordRect.bottom < viewTop) {
      setPlayheadOffscreen(true);
      setFollowDirection("up");
      return { offscreen: true as const, direction: "up" as const };
    }
    if (wordRect.top > viewBottom) {
      setPlayheadOffscreen(true);
      setFollowDirection("down");
      return { offscreen: true as const, direction: "down" as const };
    }
    setPlayheadOffscreen(false);
    return { offscreen: false as const };
  }, [scrollRef, containerRef]);

  /** Rail / gesture hint — actual unfollow waits until scroll leaves the word. */
  const markUserScrollGesture = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return;
    userScrollGestureRef.current = true;
    // Keep the gesture armed across momentum / rail-drag scroll bursts.
    window.clearTimeout(userScrollGestureTimerRef.current);
    userScrollGestureTimerRef.current = window.setTimeout(() => {
      userScrollGestureRef.current = false;
    }, 150);
  }, [scrollRef]);

  const resumeFollowPlayhead = useCallback(() => {
    followPlayheadRef.current = true;
    setFollowPlayhead(true);
    setPlayheadOffscreen(false);
  }, []);

  // User scroll pauses follow only once the active word actually leaves view.
  // Wheel over a non-scrollable pane is ignored (no Follow chip).
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onGesture = () => markUserScrollGesture();
    const onScroll = () => {
      if (!playing) return;
      const { offscreen } = measurePlayheadAnchor();
      if (userScrollGestureRef.current && offscreen) {
        followPlayheadRef.current = false;
        setFollowPlayhead(false);
        return;
      }
      // Scrolled back onto the playhead (or programmatic nearest kept it in view).
      if (!offscreen && !followPlayheadRef.current) resumeFollowPlayhead();
    };
    scroller.addEventListener("wheel", onGesture, { passive: true });
    scroller.addEventListener("touchmove", onGesture, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", onGesture);
      scroller.removeEventListener("touchmove", onGesture);
      scroller.removeEventListener("scroll", onScroll);
      window.clearTimeout(userScrollGestureTimerRef.current);
    };
  }, [
    scrollRef,
    markUserScrollGesture,
    measurePlayheadAnchor,
    resumeFollowPlayhead,
    playing,
  ]);

  // Keep the active word in view during playback while following.
  useEffect(() => {
    if (!playing || !followPlayhead || activeWordId < 0) return;
    const el = containerRef.current?.querySelector(
      `[data-wid="${activeWordId}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeWordId, playing, followPlayhead, containerRef]);

  // Refresh offscreen/direction as the playhead advances while unfollowed.
  // Measured in a frame callback so layout has settled for the newly active
  // word (and so the state update stays out of the render pass).
  useEffect(() => {
    if (followPlayhead || !playing || activeWordId < 0) return;
    const raf = requestAnimationFrame(() => {
      const { offscreen } = measurePlayheadAnchor();
      if (!offscreen) resumeFollowPlayhead();
    });
    return () => cancelAnimationFrame(raf);
  }, [
    followPlayhead,
    playing,
    activeWordId,
    measurePlayheadAnchor,
    resumeFollowPlayhead,
  ]);

  const showFollowControl =
    !followPlayhead && playheadOffscreen && playing && activeWordId >= 0;

  return {
    showFollowControl,
    followDirection,
    resumeFollowPlayhead,
    markUserScrollGesture,
  };
}
