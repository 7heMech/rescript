import type { TranscriptLanguage } from "./languages";

/** Local speech models offered on the upload screen. */
export type WhisperModel = "base" | "small";
/** NVIDIA Parakeet TDT 0.6B v3 via parakeet.js (ONNX / WebGPU). */
export type ParakeetModel = "parakeet";
export type ModelId = WhisperModel | ParakeetModel;

type DType = "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "q4f16" | "bnb4";

/** Shared UI fields for every local speech backend. */
type ModelDisplay = {
  label: string;
  description: string;
  /** Approximate download size shown in the UI. */
  size: string;
};

export type WhisperModelInfo = ModelDisplay & {
  backend: "whisper";
  /** Hugging Face model id (ONNX export compatible with transformers.js). */
  id: string;
  /** dtype configuration per device. */
  dtype: {
    webgpu: Record<string, DType>;
    wasm: Record<string, DType>;
  };
  /**
   * When true, condition Whisper on a short filler-rich initial prompt so
   * "Remove fillers" has tokens to act on. See {@link whisperFillerPrompt}.
   *
   * (A dedicated verbatim model — CrisperWhisper — was evaluated, but its
   * only browser-runnable ONNX export lacks the cross-attention outputs
   * required for word-level timestamps, which this editor depends on.)
   */
  keepFillers?: boolean;
};

export type ParakeetModelInfo = ModelDisplay & {
  backend: "parakeet";
  /** parakeet.js model key (also the weightlift registry id). */
  id: string;
  /** Hugging Face repo used by parakeet.js hub downloads / IndexedDB cache keys. */
  repoId: string;
};

export type ModelInfo = WhisperModelInfo | ParakeetModelInfo;

/** Display order for model rows in the source dropdown. */
export const MODEL_ORDER: ModelId[] = ["base", "small", "parakeet"];

/**
 * Hard cap for Whisper filler prompts. Longer `<|startofprev|>` strings
 * forced via `decoder_input_ids` have truncated multi-speaker / long-form
 * transcripts (second speaker dropped). Keep prompts to a short filler list.
 */
export const MAX_VERBATIM_PROMPT_LENGTH = 32;

/**
 * Short, language-specific filler prompts for Whisper. Deliberately tiny and
 * free of "I'm …" openers (those seeded "I'm sorry" hallucination loops).
 * The classic OpenAI example prompt is too long for our chunked decoder path.
 */
const WHISPER_FILLER_PROMPTS: Record<TranscriptLanguage, string> = {
  en: "Um, uh, hmm, er, ah.",
  es: "Em, emm, eee.",
  fr: "Euh, heu, euhm.",
  de: "Äh, ähm, öhm, mhh.",
  zh: "嗯, 呃, 额, 唔.",
};

/**
 * Filler-bias prompt for Whisper when the selected model opts into
 * {@link WhisperModelInfo.keepFillers}. Returns null when prompting is off.
 */
export function whisperFillerPrompt(
  model: ModelId,
  language: TranscriptLanguage
): string | null {
  const info = MODELS[model];
  if (info.backend !== "whisper" || !info.keepFillers) return null;
  return WHISPER_FILLER_PROMPTS[language];
}

const WHISPER_DTYPE = {
  // q4 decoder: q8 fails session creation on onnxruntime-web 1.26
  // (Missing required scale … MatMulNBits).
  webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
  wasm: { encoder_model: "fp32", decoder_model_merged: "q4" },
} satisfies WhisperModelInfo["dtype"];

/**
 * Local speech models that can run in the transcription worker.
 * Shared display fields live on every entry; backend-specific knobs
 * (`dtype` / `keepFillers` vs `repoId`) are gated by `backend`.
 */
export const MODELS: {
  base: WhisperModelInfo;
  small: WhisperModelInfo;
  parakeet: ParakeetModelInfo;
} = {
  base: {
    backend: "whisper",
    id: "onnx-community/whisper-base_timestamped",
    label: "Whisper Base",
    description: "Faster download and transcription. Good for most clips.",
    size: "~200 MB",
    dtype: WHISPER_DTYPE,
    // Short filler prompt only — long prompts truncate long-form ASR.
    keepFillers: true,
  },
  small: {
    backend: "whisper",
    id: "onnx-community/whisper-small_timestamped",
    label: "Whisper Small",
    description: "More accurate on longer or noisier audio. Larger download.",
    size: "~600 MB",
    dtype: WHISPER_DTYPE,
    keepFillers: true,
  },
  parakeet: {
    backend: "parakeet",
    id: "parakeet-tdt-0.6b-v3",
    repoId: "ysdede/parakeet-tdt-0.6b-v3-onnx",
    label: "Parakeet TDT v3",
    description:
      "NVIDIA FastConformer — faster on WebGPU, strong EU-language accuracy. Auto-detects language.",
    // WASM int8 ~670 MB; WebGPU fp16 ~1.2 GB.
    size: "~700 MB",
  },
};

export function isWhisperModel(value: unknown): value is WhisperModel {
  return value === "base" || value === "small";
}

export function isParakeetModel(value: unknown): value is ParakeetModel {
  return value === "parakeet";
}

/** Whether `value` is a key of {@link MODELS}. */
export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MODELS, value);
}

const MODEL_STORAGE_KEY = "rescript.model";

/** Read the last-selected speech model from localStorage (defaults to base). */
export function loadModelPreference(): ModelId {
  if (typeof window === "undefined") return "base";
  try {
    const raw = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (isModelId(raw)) return raw;
  } catch {
    // private mode / disabled storage
  }
  return "base";
}

/** Persist the selected speech model for the next visit. */
export function saveModelPreference(model: ModelId) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {
    // private mode / disabled storage
  }
}
