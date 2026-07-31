import type { WeightliftEvent } from "../types.js";

/** Anything that can accept normalized events (store or worker reporter). */
export interface EventSink {
  dispatch(event: WeightliftEvent): void;
}

/**
 * Shape of WebLLM / MLC `InitProgressReport`.
 * @see https://webllm.mlc.ai/
 */
export interface WebLLMInitProgressReport {
  /** 0..1 progress fraction. */
  progress: number;
  /** Human-readable status text. */
  text?: string;
  timeElapsed?: number;
}

/**
 * Convert a WebLLM `initProgressCallback` report into a normalized event.
 *
 * WebLLM exposes a single aggregate fraction (not per-file bytes), so this
 * maps onto `progress_total` with a synthetic 100-unit total.
 */
export function webllmEvent(
  report: WebLLMInitProgressReport
): WeightliftEvent {
  const progress = Math.min(1, Math.max(0, report.progress || 0));
  const total = 100;
  const loaded = progress * total;
  if (progress >= 1) {
    return {
      type: "progress_total",
      loaded: total,
      total,
      message: report.text,
    };
  }
  return {
    type: "progress_total",
    loaded,
    total,
    message: report.text,
  };
}

/**
 * Build an `initProgressCallback` for WebLLM's `CreateMLCEngine` / similar.
 *
 * ```ts
 * const wl = new Weightlift();
 * wl.start("Loading LLM…");
 * const engine = await CreateMLCEngine(modelId, {
 *   initProgressCallback: webllmAdapter(wl),
 * });
 * wl.ready();
 * ```
 */
export function webllmAdapter(
  sink: EventSink
): (report: WebLLMInitProgressReport) => void {
  return (report) => {
    sink.dispatch(webllmEvent(report));
  };
}
