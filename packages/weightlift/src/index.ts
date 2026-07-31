/**
 * weightlift — framework-agnostic progress state for in-browser ML model loading.
 *
 * @packageDocumentation
 *
 * ```ts
 * import { Weightlift } from "weightlift";
 * import { transformersAdapter } from "weightlift/adapters/transformers";
 *
 * const wl = new Weightlift();
 * wl.subscribe((s) => console.log(s.percent, s.message));
 * wl.start("Downloading model…");
 *
 * await pipeline("feature-extraction", modelId, {
 *   progress_callback: transformersAdapter(wl),
 * });
 * wl.ready();
 * ```
 */

export {
  Weightlift,
  createModelLoader,
  createModelRegistry,
  type Unsubscribe,
} from "./store.js";

export {
  reduce,
  createReduceContext,
  type ReduceContext,
} from "./reduce.js";

export {
  INITIAL_STATE,
  type LoadStatus,
  type FileProgress,
  type WeightliftState,
  type WeightliftEvent,
  type WeightliftListener,
} from "./types.js";

// Adapters are also available via dedicated entry points:
//   weightlift/adapters/transformers
//   weightlift/adapters/webllm
// Re-exported here for convenience in simple setups.
export {
  transformersAdapter,
  transformersEvent,
  type TransformersProgressInfo,
} from "./adapters/transformers.js";
export {
  webllmAdapter,
  webllmEvent,
  type WebLLMInitProgressReport,
} from "./adapters/webllm.js";
