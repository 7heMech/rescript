"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Weightlift } from "./store.js";
import type { WeightliftState } from "./types.js";

export type { WeightliftState, LoadStatus, FileProgress } from "./types.js";
export {
  Weightlift,
  createModelLoader,
  createModelRegistry,
} from "./store.js";

/**
 * Subscribe a React component to a {@link Weightlift} store.
 *
 * Built on `useSyncExternalStore` — the same pattern Zustand / TanStack Query
 * use for their vanilla cores. Safe for concurrent rendering.
 *
 * ```tsx
 * const wl = useMemo(() => new Weightlift(), []);
 * const { percent, message, isLoading } = useWeightlift(wl);
 * ```
 */
export function useWeightlift(weightlift: Weightlift): WeightliftState & {
  isLoading: boolean;
  isReady: boolean;
  isIdle: boolean;
  hasError: boolean;
} {
  const state = useSyncExternalStore(
    weightlift.subscribe,
    weightlift.getSnapshot,
    weightlift.getServerSnapshot
  );

  return {
    ...state,
    isLoading: state.status === "loading",
    isReady: state.status === "ready",
    isIdle: state.status === "idle",
    hasError: state.status === "error",
  };
}

/**
 * Create a stable {@link Weightlift} instance for the lifetime of the component.
 * Pass an optional `key` to reset when the model id changes.
 */
export function useWeightliftStore(key?: string): Weightlift {
  // key intentionally part of deps so switching models gets a fresh store.
  return useMemo(() => new Weightlift(), [key]);
}
