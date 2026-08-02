/**
 * Model choice helpers for Whisper / Parakeet / import.
 */
import {
  MODEL_ORDER,
  MODELS,
  isAsrModel,
  isModelChoice,
  isParakeetModel,
  isWhisperModel,
} from "../lib/models";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(isWhisperModel("base"), "base is Whisper");
assert(isWhisperModel("small"), "small is Whisper");
assert(!isWhisperModel("parakeet"), "parakeet is not Whisper");
assert(isParakeetModel("parakeet"), "parakeet is Parakeet");
assert(isAsrModel("parakeet"), "parakeet is ASR");
assert(isAsrModel("base"), "base is ASR");
assert(!isAsrModel("import"), "import is not ASR");
assert(isModelChoice("import"), "import is a model choice");
assert(isModelChoice("parakeet"), "parakeet is a model choice");
assert(!isModelChoice("tiny"), "tiny is not a model choice");

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

assert(
  MODEL_ORDER.includes("parakeet") && MODEL_ORDER.includes("base"),
  "MODEL_ORDER lists whisper + parakeet"
);
for (const id of MODEL_ORDER) {
  assert(isAsrModel(id), `${id} in MODEL_ORDER is an ASR model`);
  assert(typeof MODELS[id].label === "string", `${id} has label`);
  assert(typeof MODELS[id].size === "string", `${id} has size`);
}

console.log("models-test: ok");
