import type { WeightliftEvent } from "../types.js";

/** Anything that can accept normalized events (store or worker reporter). */
export interface EventSink {
  dispatch(event: WeightliftEvent): void;
}

/**
 * Subset of the transformers.js `ProgressInfo` union that carries download
 * progress. Kept structural so weightlift does not depend on
 * `@huggingface/transformers` at runtime.
 *
 * @see https://huggingface.co/docs/transformers.js/guides/progress
 */
export interface TransformersProgressInfo {
  status?: string;
  file?: string;
  name?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

/**
 * Convert a transformers.js `progress_callback` argument into a normalized
 * {@link WeightliftEvent}, or `null` if the event should be ignored.
 */
export function transformersEvent(
  p: TransformersProgressInfo
): WeightliftEvent | null {
  const status = p.status;

  if (status === "initiate" && p.file) {
    return { type: "initiate", file: p.file };
  }

  if (status === "progress_total") {
    const total = p.total ?? 0;
    if (!(total > 0)) return null;
    const loaded =
      typeof p.progress === "number"
        ? (p.progress / 100) * total
        : (p.loaded ?? 0);
    return { type: "progress_total", loaded, total };
  }

  if (status === "progress" && p.file) {
    return {
      type: "progress",
      file: p.file,
      loaded: p.loaded ?? 0,
      total: p.total,
    };
  }

  if (status === "done" && p.file) {
    return { type: "done", file: p.file };
  }

  if (status === "ready") {
    return { type: "ready" };
  }

  return null;
}

/**
 * Build a `progress_callback` suitable for `pipeline()` / `from_pretrained()`.
 *
 * ```ts
 * const wl = new Weightlift();
 * wl.start("Downloading speech model…");
 * await pipeline("automatic-speech-recognition", modelId, {
 *   progress_callback: transformersAdapter(wl),
 * });
 * wl.ready();
 * ```
 */
export function transformersAdapter(
  sink: EventSink,
  options?: { message?: string }
): (progress: TransformersProgressInfo) => void {
  if (options?.message) {
    sink.dispatch({ type: "message", message: options.message });
  }

  return (progress) => {
    const event = transformersEvent(progress);
    if (event) sink.dispatch(event);
  };
}
