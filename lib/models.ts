/** Transcription model choices offered on the upload screen. */
export type ModelChoice = "fast" | "verbatim";

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

const WHISPER_BASE = "onnx-community/whisper-base_timestamped";
const WHISPER_BASE_DTYPE = {
  // q4 decoder: q8 fails session creation on onnxruntime-web 1.26
  // (Missing required scale … MatMulNBits).
  webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" },
  wasm: { encoder_model: "fp32", decoder_model_merged: "q4" },
} satisfies ModelInfo["dtype"];

export const MODELS: Record<ModelChoice, ModelInfo> = {
  fast: {
    id: WHISPER_BASE,
    label: "Standard",
    description: "Fast on any device. May clean up filler words (\u201cum\u201d, \u201cuh\u201d).",
    size: "~80 MB",
    dtype: WHISPER_BASE_DTYPE,
  },
  verbatim: {
    id: WHISPER_BASE,
    label: "Verbatim",
    description:
      "Tries to keep filler words (\u201cum\u201d, \u201cuh\u201d) in the transcript so you can cut them. Same speed and size.",
    size: "~80 MB",
    dtype: WHISPER_BASE_DTYPE,
    verbatimPrompt:
      // Keep this short and free of "I'm …" openers — a longer prompt that
      // starts with "I'm" can seed the common "I'm sorry" hallucination loop
      // on later chunks of long audio.
      "Um, uh, hmm, er, ah.",
  },
};
