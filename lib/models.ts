/** Transcription model choices offered on the upload screen. */
export type ModelChoice = "base" | "small";

type DType = "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "q4f16" | "bnb4";

export interface ModelInfo {
  /** Hugging Face model id (ONNX export compatible with transformers.js). */
  id: string;
  label: string;
  description: string;
  /** Approximate download size shown in the UI. */
  size: string;
  /** dtype configuration per device. */
  dtype: {
    webgpu: Record<string, DType>;
    wasm: Record<string, DType>;
  };
  /**
   * Whisper is trained to produce "clean" transcripts and usually drops
   * disfluencies. Conditioning the decoder on a prompt that itself contains
   * fillers biases it toward verbatim output. The prompt is injected as
   * `<|startofprev|> …prompt… <|startoftranscript|>` decoder tokens.
   *
   * (A dedicated verbatim model — CrisperWhisper — was evaluated, but its
   * only browser-runnable ONNX export lacks the cross-attention outputs
   * required for word-level timestamps, which this editor depends on.)
   */
  verbatimPrompt?: string;
}

/** Display order for the homepage model dropdown. */
export const MODEL_ORDER: ModelChoice[] = ["base", "small"];

const WHISPER_DTYPE = {
  // q4 decoder: q8 fails session creation on onnxruntime-web 1.26
  // (Missing required scale … MatMulNBits).
  webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
  wasm: { encoder_model: "fp32", decoder_model_merged: "q4" },
} satisfies ModelInfo["dtype"];

/** Shared prompt so both sizes keep um/uh for filler editing. */
const VERBATIM_PROMPT =
  "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking, um, yeah.";

export const MODELS: Record<ModelChoice, ModelInfo> = {
  base: {
    id: "onnx-community/whisper-base_timestamped",
    label: "Whisper Base",
    description: "Faster download and transcription. Good for most clips.",
    size: "~200 MB",
    dtype: WHISPER_DTYPE,
    verbatimPrompt: VERBATIM_PROMPT,
  },
  small: {
    id: "onnx-community/whisper-small_timestamped",
    label: "Whisper Small",
    description: "More accurate on longer or noisier audio. Larger download.",
    size: "~600 MB",
    dtype: WHISPER_DTYPE,
    verbatimPrompt: VERBATIM_PROMPT,
  },
};

const MODEL_STORAGE_KEY = "rescript.model";

export function isModelChoice(value: unknown): value is ModelChoice {
  return typeof value === "string" && value in MODELS;
}

/** Read the last-selected model from localStorage (defaults to base). */
export function loadModelPreference(): ModelChoice {
  if (typeof window === "undefined") return "base";
  try {
    const raw = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (isModelChoice(raw)) return raw;
  } catch {
    // private mode / disabled storage
  }
  return "base";
}

/** Persist the selected model for the next visit. */
export function saveModelPreference(model: ModelChoice) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {
    // private mode / disabled storage
  }
}
