/**
 * Model choice helpers for Whisper / Parakeet / import.
 */
import {
  MODELS,
  PARAKEET_INFO,
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

assert(PARAKEET_INFO.id === "parakeet-tdt-0.6b-v3", "parakeet hub id");
assert(
  PARAKEET_INFO.repoId === "ysdede/parakeet-tdt-0.6b-v3-onnx",
  "parakeet HF repo id"
);
assert(typeof PARAKEET_INFO.label === "string", "parakeet label");
assert(typeof MODELS.base.id === "string", "whisper base id");
assert(typeof MODELS.small.id === "string", "whisper small id");

console.log("models-test: ok");
