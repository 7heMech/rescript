/**
 * Model + transcript-source helpers.
 */
import {
  MODEL_ORDER,
  MODELS,
  isCrisperModel,
  isLocalModel,
  isModelId,
  isParakeetModel,
  isWhisperModel,
  verbatimTagCount,
  whisperFillerPrompt,
} from "../lib/models";
import { isTranscriptSource } from "../lib/source";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(isWhisperModel("base"), "base is Whisper");
assert(isWhisperModel("small"), "small is Whisper");
assert(isWhisperModel("medium"), "medium is Whisper");
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
assert(typeof MODELS.medium.id === "string", "whisper medium id");
assert(MODELS.base.dtype.webgpu.encoder_model === "fp32", "whisper dtype");
// No model uses the <|startofprev|> filler prompt any more. Measured per VAD
// segment, it collapses Whisper Small's longest slice to a bare "Um," and
// truncates Medium to a fragment, while plain decoding transcribes every
// segment correctly and still yields "uh". See WhisperModelInfo.keepFillers.
for (const id of MODEL_ORDER) {
  const info = MODELS[id];
  if (info.backend !== "whisper") continue;
  assert(!info.keepFillers, `${id} must not use the filler prompt`);
  assert(
    whisperFillerPrompt(id, "en") === null,
    `${id} must resolve no filler prompt`
  );
}
// Medium deviates from WHISPER_DTYPE on purpose: its fp32 encoder export is
// 1.2 GB. Pin the split so a later dtype tidy-up cannot quietly reinstate it.
assert(
  MODELS.medium.dtype.wasm.encoder_model === "int8",
  "medium encoder is int8 on wasm"
);
assert(
  MODELS.medium.dtype.webgpu.encoder_model === "fp16",
  "medium encoder is fp16 on webgpu"
);

assert(
  MODEL_ORDER.includes("parakeet") && MODEL_ORDER.includes("base"),
  "MODEL_ORDER lists whisper + parakeet"
);
for (const id of MODEL_ORDER) {
  assert(isModelId(id), `${id} in MODEL_ORDER is a model id`);
  assert(typeof MODELS[id].label === "string", `${id} has label`);
  assert(typeof MODELS[id].size === "string", `${id} has size`);
}

// CrisperWhisper: verbatim comes from the [verbatim_N] mode prefix, so these
// models must NOT also get Whisper's filler-bias prompt — the two are different
// mechanisms and stacking them would corrupt the decoder prefix.
// The mode prefix is off on both: measured, it drops a clause and emits
// [breath] where the speaker hesitated, while no prefix keeps the filler.
assert(verbatimTagCount("crisperSmall") === null, "crisperSmall sends no mode prefix");
assert(verbatimTagCount("crisperTurbo") === null, "crisperTurbo sends no mode prefix");
assert(verbatimTagCount("base") === null, "base has no verbatim tags");
// The tokenizer fix-up must still run without a mode prefix — the extended
// vocabulary tokens that break word collation are emitted either way.
assert(isCrisperModel("crisperSmall"), "crisperSmall needs the tokenizer fix-up");
assert(isCrisperModel("crisperTurbo"), "crisperTurbo needs the tokenizer fix-up");
assert(!isCrisperModel("base"), "base needs no tokenizer fix-up");
assert(!isCrisperModel("parakeet"), "parakeet needs no tokenizer fix-up");
assert(
  whisperFillerPrompt("crisperSmall", "en") === null,
  "crisperSmall does not use the filler-bias prompt"
);
assert(
  whisperFillerPrompt("crisperTurbo", "en") === null,
  "crisperTurbo does not use the filler-bias prompt"
);

// Only the unpublished export is served from public/models; a stray `local`
// flag on a Hub model would send transformers.js to a path that 404s.
assert(isLocalModel("crisperSmall"), "crisperSmall is served locally");
assert(!isLocalModel("crisperTurbo"), "crisperTurbo loads from the Hub");
assert(!isLocalModel("base"), "base loads from the Hub");
assert(
  !MODELS.crisperSmall.id.includes("/"),
  "local model id is a public/models folder name, not a Hub repo id"
);
assert(
  MODELS.crisperTurbo.id === "Masterx/CrisperWhisper2.0-turbo-ONNX",
  "crisperTurbo Hub id"
);

assert(whisperFillerPrompt("parakeet", "en") === null, "parakeet has no prompt");
// The prompts themselves are still checked for length and content in
// vad-regression-test.ts, which constrains whatever any model opts back into.

console.log("models-test: ok");
