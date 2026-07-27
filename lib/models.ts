/** Transcription source choices offered on the upload screen. */
export type WhisperModel = "base" | "small";
export type ModelChoice = WhisperModel | "import";

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

/** Display order for Whisper rows in the homepage source dropdown. */
export const WHISPER_ORDER: WhisperModel[] = ["base", "small"];

/** @deprecated Prefer WHISPER_ORDER; kept for older imports. */
export const MODEL_ORDER = WHISPER_ORDER;

const WHISPER_DTYPE = {
  // q4 decoder: q8 fails session creation on onnxruntime-web 1.26
  // (Missing required scale … MatMulNBits).
  webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
  wasm: { encoder_model: "fp32", decoder_model_merged: "q4" },
} satisfies ModelInfo["dtype"];

/** Whisper models that can run in the transcription worker. */
export const MODELS: Record<WhisperModel, ModelInfo> = {
  base: {
    id: "onnx-community/whisper-base_timestamped",
    label: "Whisper Base",
    description: "Faster download and transcription. Good for most clips.",
    size: "~200 MB",
    dtype: WHISPER_DTYPE,
    // Do not set verbatimPrompt: forcing a long <|startofprev|> prompt via
    // decoder_input_ids truncates long-form transcripts (e.g. drops the second
    // speaker on mixed clips). Prefer post-process / filler tools instead.
  },
  small: {
    id: "onnx-community/whisper-small_timestamped",
    label: "Whisper Small",
    description: "More accurate on longer or noisier audio. Larger download.",
    size: "~600 MB",
    dtype: WHISPER_DTYPE,
  },
};

export function isWhisperModel(value: unknown): value is WhisperModel {
  return value === "base" || value === "small";
}

export function isModelChoice(value: unknown): value is ModelChoice {
  return isWhisperModel(value) || value === "import";
}

const MODEL_STORAGE_KEY = "rescript.model";

/** Read the last-selected Whisper model from localStorage (defaults to base). */
export function loadModelPreference(): WhisperModel {
  if (typeof window === "undefined") return "base";
  try {
    const raw = window.localStorage.getItem(MODEL_STORAGE_KEY);
    // Ignore a stale "import" preference — that choice is session-only until a
    // transcript file is picked again.
    if (isWhisperModel(raw)) return raw;
  } catch {
    // private mode / disabled storage
  }
  return "base";
}

/** Persist the selected Whisper model for the next visit. */
export function saveModelPreference(model: WhisperModel) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {
    // private mode / disabled storage
  }
}
