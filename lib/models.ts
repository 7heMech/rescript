import type { TranscriptLanguage } from "./languages";

/** Local speech models offered on the upload screen. */
export type WhisperModel =
  | "base"
  | "small"
  | "medium"
  /** CrisperWhisper 2.0 Small, exported by tools/crisperwhisper-onnx. */
  | "crisperSmall"
  /** CrisperWhisper 2.0 Turbo, published ONNX export. */
  | "crisperTurbo";
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
   * **Currently unset on every model — the prompt does more harm than good.**
   * Measured on an 11.5 s clip, decoding each VAD segment the way the worker
   * does, Whisper Small with the prompt attached:
   *
   * | slice        | plain                       | + prompt              |
   * |--------------|-----------------------------|-----------------------|
   * | full 11.5 s  | complete, includes "uh"     | "Nice. How does it, uh," |
   * | 2.5–5.0 s    | "Nice. How does it work?"   | "Nice. How does it"   |
   * | 5.0–11.5 s   | complete sentence           | **"Um,"**             |
   *
   * The long tail segment collapses into an echo of the prompt. Medium behaves
   * the same way, and Base is only marginally more robust. This is the
   * truncation {@link MAX_VERBATIM_PROMPT_LENGTH} was meant to bound, but the
   * length cap does not prevent it — a 20-character prompt still triggers it.
   *
   * Little is lost by dropping it: plain decoding already yields "uh" on this
   * clip, and anything the model does swallow is still recovered as a timed
   * `...` placeholder by {@link insertDisfluencyPlaceholders}, so it stays
   * cuttable. Kept as a one-flag switch for re-testing on other material.
   */
  keepFillers?: boolean;
  /**
   * CrisperWhisper mode prefix: how many `[verbatim_N]` tags to prime the
   * decoder with. CrisperWhisper 2.0 picks verbatim vs. intended output purely
   * from this prefix — the encoder output is identical either way — and unlike
   * Whisper's initial prompt there is no `<|startofprev|>`; the tags come
   * first and the standard prefix follows. Verbatim output spells fillers as
   * `[UM]` / `[UH]`, which `lib/fillers.ts` already matches once punctuation is
   * stripped. Source: `crisperwhisper==2.0.1`, `crisperwhisper/prompt.py`.
   */
  verbatimTags?: number;
  /**
   * Load from `public/models/<id>/` instead of the Hub. Used for exports that
   * have not been published yet — see tools/crisperwhisper-onnx.
   */
  local?: boolean;
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
export const MODEL_ORDER: ModelId[] = [
  "base",
  "small",
  "medium",
  "parakeet",
  "crisperSmall",
  "crisperTurbo",
];

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
 * Medium cannot share {@link WHISPER_DTYPE}: its fp32 encoder export is 1.2 GB,
 * which no browser tab survives instantiating. Splits per device the same way
 * {@link MODELS.parakeet} already does — fp16 encoder on WebGPU, int8 on WASM —
 * and keeps the q4 merged decoder that Base and Small are proven on.
 */
const WHISPER_MEDIUM_DTYPE = {
  webgpu: { encoder_model: "fp16", decoder_model_merged: "q4" },
  wasm: { encoder_model: "int8", decoder_model_merged: "q4" },
} satisfies WhisperModelInfo["dtype"];

/**
 * Both CrisperWhisper exports run q4 on either device — it is the only
 * quantisation available for the merged decoder in both repos, because
 * `quantize_dynamic` cannot reach weights inside the merged decoder's
 * control-flow subgraphs (see tools/crisperwhisper-onnx/README.md). The q4 pair
 * is also the combination verified end-to-end for the local export.
 */
const CRISPER_DTYPE = {
  webgpu: { encoder_model: "q4", decoder_model_merged: "q4" },
  wasm: { encoder_model: "q4", decoder_model_merged: "q4" },
} satisfies WhisperModelInfo["dtype"];

/**
 * Local speech models that can run in the transcription worker.
 * Shared display fields live on every entry; backend-specific knobs
 * (`dtype` / `keepFillers` vs `repoId`) are gated by `backend`.
 */
export const MODELS: {
  base: WhisperModelInfo;
  small: WhisperModelInfo;
  medium: WhisperModelInfo;
  parakeet: ParakeetModelInfo;
  crisperSmall: WhisperModelInfo;
  crisperTurbo: WhisperModelInfo;
} = {
  base: {
    backend: "whisper",
    id: "onnx-community/whisper-base_timestamped",
    label: "Whisper Base",
    description: "Faster download and transcription. Good for most clips.",
    size: "~200 MB",
    dtype: WHISPER_DTYPE,
  },
  small: {
    backend: "whisper",
    id: "onnx-community/whisper-small_timestamped",
    label: "Whisper Small",
    description: "More accurate on longer or noisier audio. Larger download.",
    size: "~600 MB",
    dtype: WHISPER_DTYPE,
  },
  medium: {
    backend: "whisper",
    id: "onnx-community/whisper-medium_timestamped",
    label: "Whisper Medium",
    description:
      "Best accuracy on accents, crosstalk and poor recordings. Slow, and a big download.",
    // WASM int8 encoder + q4 decoder ~780 MB; WebGPU fp16 encoder ~1.1 GB.
    size: "~1.1 GB",
    dtype: WHISPER_MEDIUM_DTYPE,
    // No filler prompt, unlike Base and Small. Medium is far more sensitive to
    // <|startofprev|> conditioning than they are: measured on an 11.5 s clip,
    // both dtype configs transcribe it in full unprompted, and both collapse to
    // the fragment "Nice. How does it, uh..." with the prompt attached — the
    // truncation failure {@link MAX_VERBATIM_PROMPT_LENGTH} describes, except
    // triggered by a prompt already inside that cap. It costs nothing here:
    // Medium emits "uh" on its own, which is all the prompt was there to buy.
  },
  parakeet: {
    backend: "parakeet",
    id: "parakeet-tdt-0.6b-v3",
    repoId: "ysdede/parakeet-tdt-0.6b-v3-onnx",
    label: "Parakeet TDT v3",
    description:
      "NVIDIA FastConformer — faster on WebGPU, strong EU-language accuracy. Auto-detects language.",
    // WASM int8 encoder + fp16 decoder ~690 MB; WebGPU fp16 + fp32 ~1.3 GB.
    size: "~1.3 GB",
  },
  crisperSmall: {
    backend: "whisper",
    // Local folder under public/models — not published yet. Install with
    // `python tools/crisperwhisper-onnx/install_local.py`.
    id: "crisperwhisper-2.0-small-onnx",
    local: true,
    label: "CrisperWhisper Small (local)",
    description:
      "Verbatim: transcribes fillers as [UM] / [UH] instead of dropping them. Self-exported, unpublished. Non-commercial licence.",
    // q4 encoder 66 MB + q4 merged decoder 258 MB.
    size: "~324 MB",
    dtype: CRISPER_DTYPE,
    verbatimTags: 5,
  },
  crisperTurbo: {
    backend: "whisper",
    id: "Masterx/CrisperWhisper2.0-turbo-ONNX",
    label: "CrisperWhisper Turbo",
    description:
      "Verbatim, on a large-v3 encoder. The most accurate verbatim option, and the largest download. Non-commercial licence.",
    // q4 encoder 425 MB + q4 merged decoder 600 MB.
    size: "~1.0 GB",
    dtype: CRISPER_DTYPE,
    verbatimTags: 5,
  },
};

/** Whether `model` is steered with CrisperWhisper's `[verbatim_N]` prefix. */
export function verbatimTagCount(model: ModelId): number | null {
  const info = MODELS[model];
  return info.backend === "whisper" ? (info.verbatimTags ?? null) : null;
}

/** Whether `model` loads from public/models rather than the Hub. */
export function isLocalModel(model: ModelId): boolean {
  const info = MODELS[model];
  return info.backend === "whisper" && info.local === true;
}

export function isWhisperModel(value: unknown): value is WhisperModel {
  return (
    value === "base" ||
    value === "small" ||
    value === "medium" ||
    value === "crisperSmall" ||
    value === "crisperTurbo"
  );
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
