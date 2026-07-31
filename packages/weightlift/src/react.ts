"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  ModelManager,
  idleRecord,
  type ManagerSnapshot,
  type ModelRecord,
} from "./manager.js";
import { Weightlift } from "./store.js";
import type { WeightliftState } from "./types.js";

export type {
  WeightliftState,
  LoadStatus,
  FileProgress,
} from "./types.js";
export type {
  ModelRecord,
  ManagerSnapshot,
  ModelDefinition,
  LoadContext,
} from "./manager.js";
export {
  Weightlift,
  createModelLoader,
  createModelRegistry,
} from "./store.js";
export { ModelManager } from "./manager.js";

/**
 * Subscribe to the full {@link ModelManager} snapshot.
 *
 * ```tsx
 * const { models, loading } = useModelManager(manager);
 * ```
 */
export function useModelManager(manager: ModelManager): ManagerSnapshot {
  return useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getServerSnapshot
  );
}

/**
 * Subscribe to one model id on a {@link ModelManager}.
 *
 * ```tsx
 * const { status, percent, message, value, load } = useModel(manager, "whisper-base");
 * ```
 */
export function useModel<T = unknown>(
  manager: ModelManager,
  id: string
): ModelRecord & {
  isLoading: boolean;
  isReady: boolean;
  isIdle: boolean;
  hasError: boolean;
  /** Ready model instance, or `undefined`. */
  value: T | undefined;
  load: () => Promise<T>;
  unload: () => Promise<void>;
} {
  const snapshot = useModelManager(manager);
  const record = snapshot.models[id] ?? idleRecord(id);

  const load = useCallback(() => manager.load<T>(id), [manager, id]);
  const unload = useCallback(() => manager.unload(id), [manager, id]);

  return {
    ...record,
    isLoading: record.status === "loading",
    isReady: record.status === "ready",
    isIdle: record.status === "idle",
    hasError: record.status === "error",
    // Read through to the manager so the handle appears once status is ready.
    value: manager.get<T>(id),
    load,
    unload,
  };
}

/**
 * Create a stable {@link ModelManager} for the lifetime of the component.
 */
export function useModelManagerStore(): ModelManager {
  return useMemo(() => new ModelManager(), []);
}

/**
 * Subscribe a React component to a low-level {@link Weightlift} progress store.
 * Prefer {@link useModel} / {@link useModelManager} for the manager API.
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
  return useMemo(() => new Weightlift(), [key]);
}
