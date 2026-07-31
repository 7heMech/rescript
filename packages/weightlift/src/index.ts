/**
 * weightlift — in-browser ML model manager with download progress.
 *
 * @packageDocumentation
 *
 * ```ts
 * import { ModelManager } from "weightlift";
 * import { transformersAdapter } from "weightlift/adapters/transformers";
 *
 * const models = new ModelManager();
 * models.define("whisper-base", {
 *   load: async ({ progress }) =>
 *     pipeline("automatic-speech-recognition", modelId, {
 *       progress_callback: transformersAdapter(progress),
 *     }),
 * });
 *
 * const asr = await models.load("whisper-base");
 * ```
 */

export {
  ModelManager,
  type LoadContext,
  type ModelDefinition,
  type ModelRecord,
  type ManagerSnapshot,
  type ManagerListener,
} from "./manager.js";

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
