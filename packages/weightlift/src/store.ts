import { reduce, createReduceContext, type ReduceContext } from "./reduce.js";
import {
  INITIAL_STATE,
  type WeightliftEvent,
  type WeightliftListener,
  type WeightliftState,
} from "./types.js";

export type Unsubscribe = () => void;

/**
 * Framework-agnostic model-load progress store.
 *
 * Works in vanilla JS, Vue, Svelte, and — importantly — inside a web worker,
 * where model loading actually happens. Feed it normalized {@link WeightliftEvent}s
 * (directly or via a runtime adapter); subscribe for a single aggregated state.
 */
export class Weightlift {
  #state: WeightliftState = { ...INITIAL_STATE, files: {} };
  #listeners = new Set<WeightliftListener>();
  #ctx: ReduceContext = createReduceContext();

  /** Current snapshot (referentially stable until the next event). */
  getSnapshot = (): WeightliftState => this.#state;

  /** SSR / server snapshot — always the idle initial state. */
  getServerSnapshot = (): WeightliftState => INITIAL_STATE;

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * Compatible with `useSyncExternalStore`.
   */
  subscribe = (listener: WeightliftListener): Unsubscribe => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Dispatch a normalized progress event. */
  dispatch(event: WeightliftEvent): void {
    const next = reduce(this.#state, event, this.#ctx);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) {
      listener(next);
    }
  }

  /** Convenience: mark loading started with an optional label. */
  start(message?: string): void {
    this.dispatch({ type: "start", message });
  }

  /** Convenience: mark the model ready. */
  ready(message?: string): void {
    this.dispatch({ type: "ready", message });
  }

  /** Convenience: record a failure. */
  fail(error: unknown, message?: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.dispatch({ type: "error", error: err, message });
  }

  /** Reset to idle (e.g. before loading a different model). */
  reset(): void {
    this.dispatch({ type: "reset" });
  }

  /**
   * Shorthand getters matching the common `isLoading` / `isReady` UI pattern.
   */
  get status(): WeightliftState["status"] {
    return this.#state.status;
  }

  get isLoading(): boolean {
    return this.#state.status === "loading";
  }

  get isReady(): boolean {
    return this.#state.status === "ready";
  }

  get isIdle(): boolean {
    return this.#state.status === "idle";
  }

  get hasError(): boolean {
    return this.#state.status === "error";
  }
}

/**
 * Deduplicating loader for a single model. Prefer {@link ModelManager} when
 * you manage more than one id (cache labels, unload, manager snapshots).
 */
export function createModelLoader<T>(loadFn: (wl: Weightlift) => Promise<T>): {
  weightlift: Weightlift;
  load: () => Promise<T>;
  /** Drop the cached promise so the next `load()` runs again. */
  invalidate: () => void;
} {
  const weightlift = new Weightlift();
  let promise: Promise<T> | null = null;

  return {
    weightlift,
    load: () => {
      if (!promise) {
        weightlift.reset();
        weightlift.start();
        promise = loadFn(weightlift).then(
          (value) => {
            weightlift.ready();
            return value;
          },
          (err) => {
            weightlift.fail(err);
            promise = null;
            throw err;
          }
        );
      }
      return promise;
    },
    invalidate: () => {
      promise = null;
    },
  };
}

/**
 * Multi-model registry of {@link createModelLoader}s.
 * Prefer {@link ModelManager} for the full define/load/unload API.
 */
export function createModelRegistry<T>() {
  const loaders = new Map<
    string,
    ReturnType<typeof createModelLoader<T>>
  >();

  return {
    get(key: string, loadFn: (wl: Weightlift) => Promise<T>) {
      let loader = loaders.get(key);
      if (!loader) {
        loader = createModelLoader(loadFn);
        loaders.set(key, loader);
      }
      return loader;
    },
    has(key: string): boolean {
      return loaders.has(key);
    },
    invalidate(key: string): void {
      loaders.get(key)?.invalidate();
    },
    clear(): void {
      loaders.clear();
    },
  };
}
