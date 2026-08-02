/**
 * Model + transcript-source helpers.
 */
import {
  MAX_VERBATIM_PROMPT_LENGTH,
  MODEL_ORDER,
  MODELS,
  isModelId,
  isParakeetModel,
  isWhisperModel,
  whisperFillerPrompt,
} from "../lib/models";
import { isTranscriptSource } from "../lib/source";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(isWhisperModel("base"), "base is Whisper");
assert(isWhisperModel("small"), "small is Whisper");
assert(!isWhisperModel("parakeet"), "parakeet is not Whisper");
assert(isParakeetModel("parakeet"), "parakeet is Parakeet");
assert(isModelId("parakeet"), "parakeet is a model id");
assert(isModelId("base"), "base is a model id");
assert(!isModelId("import"), "import is not a model id");
assert(isTranscriptSource("import"), "import is a transcript source");
assert(isTranscriptSource("parakeet"), "parakeet is a transcript source");
assert(!isTranscriptSource("tiny"), "tiny is not a transcript source");

assert(MODELS.parakeet.backend === "parakeet", "parakeet backend");
assert(MODELS.parakeet.id === "parakeet-tdt-0.6b-v3", "parakeet hub id");
assert(
  MODELS.parakeet.repoId === "ysdede/parakeet-tdt-0.6b-v3-onnx",
  "parakeet HF repo id"
);
assert(typeof MODELS.parakeet.label === "string", "parakeet label");
assert(MODELS.base.backend === "whisper", "base backend");
assert(typeof MODELS.base.id === "string", "whisper base id");
assert(typeof MODELS.small.id === "string", "whisper small id");
assert(MODELS.base.dtype.webgpu.encoder_model === "fp32", "whisper dtype");
assert(MODELS.base.keepFillers === true, "base keeps fillers");
assert(MODELS.small.keepFillers === true, "small keeps fillers");

assert(
  MODEL_ORDER.includes("parakeet") && MODEL_ORDER.includes("base"),
  "MODEL_ORDER lists whisper + parakeet"
);
for (const id of MODEL_ORDER) {
  assert(isModelId(id), `${id} in MODEL_ORDER is a model id`);
  assert(typeof MODELS[id].label === "string", `${id} has label`);
  assert(typeof MODELS[id].size === "string", `${id} has size`);
}

assert(whisperFillerPrompt("base", "en") === "Um, uh, hmm, er, ah.", "en prompt");
assert(whisperFillerPrompt("small", "de") === "Äh, ähm, öhm, mhh.", "de prompt");
assert(whisperFillerPrompt("parakeet", "en") === null, "parakeet has no prompt");
assert(
  (whisperFillerPrompt("base", "en")?.length ?? 0) <= MAX_VERBATIM_PROMPT_LENGTH,
  "en prompt within length cap"
);

console.log("models-test: ok");
