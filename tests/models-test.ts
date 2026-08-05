/**
 * Model + transcript-source helpers.
 */
import {
  MODEL_ORDER,
  MODELS,
  // isCrisperModel,
  // isLocalModel,
  isModelId,
  isParakeetModel,
  isWhisperModel,
} from "../lib/models";
import { isTranscriptSource } from "../lib/source";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(isWhisperModel("base"), "base is Whisper");
assert(isWhisperModel("small"), "small is Whisper");
// assert(isWhisperModel("medium"), "medium is Whisper");
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
// assert(typeof MODELS.medium.id === "string", "whisper medium id");
assert(MODELS.base.dtype.webgpu.encoder_model === "fp32", "whisper dtype");
// Medium deviates from WHISPER_DTYPE on purpose: its fp32 encoder export is
// 1.2 GB. Pin the split so a later dtype tidy-up cannot quietly reinstate it.
// assert(
//   MODELS.medium.dtype.wasm.encoder_model === "int8",
//   "medium encoder is int8 on wasm"
// );
// assert(
//   MODELS.medium.dtype.webgpu.encoder_model === "fp16",
//   "medium encoder is fp16 on webgpu"
// );

assert(
  MODEL_ORDER.includes("parakeet") && MODEL_ORDER.includes("base"),
  "MODEL_ORDER lists whisper + parakeet"
);
for (const id of MODEL_ORDER) {
  assert(isModelId(id), `${id} in MODEL_ORDER is a model id`);
  assert(typeof MODELS[id].label === "string", `${id} has label`);
  assert(typeof MODELS[id].size === "string", `${id} has size`);
}

// Turbo runs fp16 on the merged decoder, not q4: on q4 it collapsed after the
// first VAD segment, and bisection cleared the encoder (a q4 encoder under an
// fp32 decoder reproduces the fp32 transcript exactly). fp16 is also 477 MB
// against q4's 600 MB. Pinned so a dtype tidy-up cannot fold it back into the
// Small config.
// assert(
//   MODELS.crisperTurbo.dtype.wasm.decoder_model_merged === "fp16" &&
//     MODELS.crisperTurbo.dtype.webgpu.decoder_model_merged === "fp16",
//   "crisperTurbo decodes in fp16"
// );
// assert(
//   MODELS.crisperSmall.dtype.wasm.decoder_model_merged === "q4",
//   "crisperSmall keeps the verified q4 decoder"
// );

// The tokenizer fix-up is required by CrisperWhisper's vocabulary layout: the
// extended tokens that break word collation are emitted whether or not the
// decoder is primed with anything.
// assert(isCrisperModel("crisperSmall"), "crisperSmall needs the tokenizer fix-up");
// assert(isCrisperModel("crisperTurbo"), "crisperTurbo needs the tokenizer fix-up");
// assert(!isCrisperModel("base"), "base needs no tokenizer fix-up");
// assert(!isCrisperModel("parakeet"), "parakeet needs no tokenizer fix-up");

// Only the unpublished export is served from public/models; a stray `local`
// flag on a Hub model would send transformers.js to a path that 404s.
// assert(isLocalModel("crisperSmall"), "crisperSmall is served locally");
// assert(!isLocalModel("crisperTurbo"), "crisperTurbo loads from the Hub");
// assert(!isLocalModel("base"), "base loads from the Hub");
// assert(
//   !MODELS.crisperSmall.id.includes("/"),
//   "local model id is a public/models folder name, not a Hub repo id"
// );
// assert(
//   MODELS.crisperTurbo.id === "Masterx/CrisperWhisper2.0-turbo-ONNX",
//   "crisperTurbo Hub id"
// );

console.log("models-test: ok");
