import type { TranscriptLanguage } from "./languages";
import type { CtcNormalizeMode } from "./forcedAlign";

/** CTC acoustic model used to force-align a transcript to audio. */
export interface AlignModelInfo {
  /** Hugging Face / transformers.js model id. */
  id: string;
  /** How transcript text is folded into this model's character vocabulary. */
  normalize: CtcNormalizeMode;
}

/**
 * Language → CTC aligner map (WhisperX-style).
 *
 * English keeps the small Librispeech wav2vec2. European languages share the
 * multilingual MMS forced-aligner (Latin a–z after accent folding). Chinese
 * uses an XLS-R CTC model whose vocab includes Han characters. Languages with
 * no entry skip CTC and keep the VAD/envelope heuristic only.
 *
 * Bulgarian is deliberately absent. The MMS aligner the other European languages
 * share expects romanised Latin — its vocabulary has no Cyrillic — and there is
 * no `normalize` mode that transliterates, so pointing `bg` at it would align
 * against characters the model never emits and produce worse timings than the
 * heuristic. Adding it means adding a Cyrillic CTC model plus a matching
 * {@link CtcNormalizeMode}.
 */
export const ALIGN_MODELS: Partial<
  Record<TranscriptLanguage, AlignModelInfo>
> = {
  en: {
    id: "Xenova/wav2vec2-base-960h",
    normalize: "latin-upper",
  },
  es: {
    id: "onnx-community/mms-300m-1130-forced-aligner-ONNX",
    normalize: "latin-lower",
  },
  fr: {
    id: "onnx-community/mms-300m-1130-forced-aligner-ONNX",
    normalize: "latin-lower",
  },
  de: {
    id: "onnx-community/mms-300m-1130-forced-aligner-ONNX",
    normalize: "latin-lower",
  },
  zh: {
    id: "onnx-community/wav2vec2-large-xlsr-53-chinese-zh-cn-ONNX",
    normalize: "cjk",
  },
};

/** Align model for a transcript language, or null when CTC is unavailable. */
export function alignModelFor(
  language: TranscriptLanguage | string | undefined
): AlignModelInfo | null {
  if (!language) return null;
  return ALIGN_MODELS[language as TranscriptLanguage] ?? null;
}

/** Unique Hugging Face ids referenced by {@link ALIGN_MODELS}. */
export function uniqueAlignModelIds(): string[] {
  return [...new Set(Object.values(ALIGN_MODELS).map((m) => m.id))];
}
