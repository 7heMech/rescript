/** High-level load lifecycle. */
export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Per-file download / cache-read progress. */
export interface FileProgress {
  loaded: number;
  /** `null` when the server omitted Content-Length. */
  total: number | null;
  status: "pending" | "downloading" | "done";
}

/**
 * Aggregated model-load state.
 *
 * `percent` is `null` (and `indeterminate` is true) when no usable byte total
 * is known yet — files can download in parallel and some servers omit
 * Content-Length, so a single 0..1 bar is not always available.
 */
export interface WeightliftState {
  status: LoadStatus;
  /** Human-readable label, e.g. "Downloading speech model…". */
  message: string;
  files: Record<string, FileProgress>;
  loadedBytes: number;
  /** Sum of known file totals; `null` if none reported a total. */
  totalBytes: number | null;
  /** 0..1 progress, or `null` when indeterminate. */
  percent: number | null;
  indeterminate: boolean;
  error: Error | null;
}

/**
 * Normalized progress events. Runtime adapters convert Transformers.js /
 * WebLLM / whisper.cpp callbacks into this shape before feeding the store.
 */
export type WeightliftEvent =
  | { type: "start"; message?: string }
  | { type: "initiate"; file: string }
  | {
      type: "progress";
      file: string;
      loaded: number;
      /** Omit or pass `undefined` when Content-Length is missing. */
      total?: number;
    }
  /**
   * Runtime-provided aggregate (e.g. transformers.js `progress_total`).
   * Preferred over summing per-file events when available — totals are often
   * pre-seeded so the bar does not jump to 100% after the first file finishes.
   */
  | { type: "progress_total"; loaded: number; total: number; message?: string }
  | { type: "done"; file: string }
  | { type: "ready"; message?: string }
  | { type: "error"; error: Error; message?: string }
  | { type: "message"; message: string }
  | { type: "reset" };

export type WeightliftListener = (state: WeightliftState) => void;

export const INITIAL_STATE: WeightliftState = {
  status: "idle",
  message: "",
  files: {},
  loadedBytes: 0,
  totalBytes: null,
  percent: null,
  indeterminate: true,
  error: null,
};
