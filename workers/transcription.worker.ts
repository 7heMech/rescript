/**
 * Transcription worker: runs entirely in the browser.
 *
 * 1. Silero VAD (energy fallback) finds speech segments; silence is skipped.
 * 2. ASR (Whisper via transformers.js, or Parakeet TDT v3 via parakeet.js)
 *    transcribes each segment with per-word timestamps, remapped onto the
 *    original timeline.
 * 3. Pyannote segmentation 3.0 assigns a speaker to each word.
 *
 * Both ASR backends and the CTC aligner are registered in a weightlift
 * ModelManager so download progress, cache labeling, and WebGPU→WASM fallback
 * share one path. Weights land in Cache Storage (Whisper, aligner) or IndexedDB
 * (Parakeet); later runs are offline. ORT WASM is served same-origin from
 * /vendor/ort* .
 */
import {
  pipeline,
  AutoProcessor,
  AutoModel,
  AutoModelForAudioFrameClassification,
  AutoModelForCTC,
  AutoTokenizer,
  WhisperTextStreamer,
  Tensor,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import { ModelManager, type ModelDefinition } from "weightlift";
import {
  fallbackDevicePolicy,
  isTransformersModelCached,
  transformersModel,
  transformersProgress,
} from "weightlift/transformers";
import type { Word, WorkerRequest, WorkerResponse } from "@/lib/types";
import {
  MODELS,
  isParakeetModel,
  isWhisperModel,
  whisperFillerPrompt,
  type ModelId,
  type WhisperModel,
} from "@/lib/models";
import { cleanTranscript } from "@/lib/hallucinations";
import { alignWordsToSpeech, speechEnvelope } from "@/lib/align";
import { insertDisfluencyPlaceholders } from "@/lib/disfluencies";
import {
  alignBatch,
  expandToAcoustics,
  groupWordsForAlignment,
  type CtcEmission,
  type CtcVocab,
} from "@/lib/forcedAlign";
import {
  VAD_FRAME_SIZE,
  VAD_SAMPLE_RATE,
  energySpeechFrames,
  speechSegmentsFromFrames,
  type SpeechSegment,
} from "@/lib/vad";
import { isWebGpuDeviceLostError } from "@/lib/webgpu";

env.allowLocalModels = false;
const ORT_WASM_PATHS = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/vendor/ort/`;
/** Parakeet.js pins onnxruntime-web@1.24.1 — keep its WASM on a separate path. */
const PARAKEET_ORT_WASM_PATHS = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/vendor/ort-parakeet/`;
// Serve onnxruntime-web WASM from our own origin (offline friendly).
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = ORT_WASM_PATHS;
}

const DIARIZATION_MODEL = "onnx-community/pyannote-segmentation-3.0";
const VAD_MODEL = "onnx-community/silero-vad";
/**
 * Character-level CTC model used to place word boundaries against the audio.
 * Whisper's own timestamps are a by-product of decoding and only roughly right;
 * this measures them.
 */
const ALIGN_MODEL = "Xenova/wav2vec2-base-960h";
/** `|` in the wav2vec2 vocabulary — the between-words symbol. */
const ALIGN_DELIMITER_ID = 4;
/** Viterbi needs a frames x tokens lattice, so alignment runs in bounded batches. */
const ALIGN_BATCH_MAX_S = 20;
/** Context either side of a batch, so edge words are not clipped. */
const ALIGN_BATCH_PAD_S = 0.2;
/** Gaps longer than this split speech into separate Whisper jobs. */
const SPEECH_MAX_GAP_S = 1.5;
/** Pad each speech region so phoneme edges are not clipped. */
const SPEECH_PAD_S = 0.4;
/**
 * Whisper often emits EOS after the first speaker when a VAD slice starts on
 * speech with no leading silence. Prepend this much zero-pad before decode
 * (timestamps are remapped so the pad does not shift the timeline).
 */
const WHISPER_LEAD_PAD_S = 0.5;

type AsrChunk = { text: string; timestamp: [number, number | null] };

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

/** Device the current ASR pipeline is running on. */
let asrDevice: "webgpu" | "wasm" = "wasm";

type ParakeetInstance = {
  transcribe: (
    audio: Float32Array,
    sampleRate?: number,
    opts?: {
      returnTimestamps?: boolean;
      timeOffset?: number;
    }
  ) => Promise<{
    utterance_text: string;
    words: Array<{ text: string; start_time: number; end_time: number }>;
  }>;
};

const PARAKEET_CACHE_DB = "parakeet-cache-db";
const PARAKEET_CACHE_STORE = "file-store";

/** Whether Parakeet ONNX weights already sit in parakeet.js IndexedDB. */
async function isParakeetCached(): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  // Avoid opening (and thereby creating) the DB when nothing has been cached.
  try {
    if (typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === PARAKEET_CACHE_DB)) return false;
    }
  } catch {
    // databases() can throw in private mode; fall through to open().
  }

  const repoId = MODELS.parakeet.repoId;
  // Hub keys: `hf-${repoId}-main--${filename}` (empty subfolder).
  const candidates = [
    `hf-${repoId}-main--encoder-model.int8.onnx`,
    `hf-${repoId}-main--encoder-model.fp16.onnx`,
  ];
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(PARAKEET_CACHE_DB);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onsuccess = () => resolve(req.result);
    });
    if (!db.objectStoreNames.contains(PARAKEET_CACHE_STORE)) {
      db.close();
      return false;
    }
    const hit = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction([PARAKEET_CACHE_STORE], "readonly");
      const store = tx.objectStore(PARAKEET_CACHE_STORE);
      let pending = candidates.length;
      let found = false;
      for (const key of candidates) {
        const req = store.get(key);
        req.onsuccess = () => {
          const blob = req.result as Blob | undefined;
          if (blob && blob.size > 1_000_000) found = true;
          pending -= 1;
          if (pending === 0) resolve(found);
        };
        req.onerror = () => reject(req.error ?? new Error("IndexedDB get failed"));
      }
    });
    db.close();
    return hit;
  } catch {
    return false;
  }
}

/**
 * Parakeet via parakeet.js — custom weightlift definition (not transformers.js).
 * WebGPU uses fp16 encoder; WASM int8 is the size / compatibility fallback.
 */
function parakeetModel(): ModelDefinition<ParakeetInstance> {
  return {
    isCached: isParakeetCached,
    load: async ({ progress }) => {
      const { fromHub } = await import("parakeet.js");
      const onProgress = (p: { loaded: number; total: number; file: string }) => {
        if (!p.file) return;
        progress.dispatch({
          type: "progress",
          file: p.file,
          loaded: p.loaded,
          ...(p.total > 0 ? { total: p.total } : {}),
        });
      };
      const common = {
        preprocessorBackend: "js" as const,
        progress: onProgress,
        wasmPaths: PARAKEET_ORT_WASM_PATHS,
      };

      // WebGPU cannot run the int8 encoder; fp16 (~1.2 GB) is the practical
      // WebGPU path. WASM int8 (~670 MB) is the compatibility / size fallback.
      const device = await fallbackDevicePolicy.pickDevice();
      if (device === "webgpu") {
        try {
          const model = await fromHub(MODELS.parakeet.id, {
            ...common,
            backend: "webgpu",
            encoderQuant: "fp16",
            decoderQuant: "int8",
          });
          asrDevice = "webgpu";
          return model as ParakeetInstance;
        } catch (err) {
          console.warn(
            "Parakeet WebGPU/fp16 load failed; falling back to WASM int8.",
            err
          );
          fallbackDevicePolicy.preferWasm();
        }
      }

      const model = await fromHub(MODELS.parakeet.id, {
        ...common,
        backend: "wasm",
        encoderQuant: "int8",
        decoderQuant: "int8",
      });
      asrDevice = "wasm";
      return model as ParakeetInstance;
    },
  };
}

/**
 * ASR registry keyed by each model's `id` from MODELS. Definitions are
 * registered up front; loaders only take an id. unloadAll() after a WebGPU
 * loss forces a clean reload on WASM.
 */
const models = new ModelManager({
  models: Object.fromEntries(
    (Object.keys(MODELS) as ModelId[]).map((choice) => {
      const info = MODELS[choice];
      if (info.backend === "parakeet") {
        return [info.id, parakeetModel()];
      }
      return [
        info.id,
        transformersModel<AutomaticSpeechRecognitionPipeline>({
          pipeline,
          task: "automatic-speech-recognition",
          modelId: info.id,
          dtype: info.dtype,
          cacheKey: env.cacheKey ?? "transformers-cache",
          onDevice: (device) => {
            asrDevice = device;
          },
        }),
      ];
    })
  ),
});
models.subscribe((snap) => {
  const id = snap.loading[0];
  if (!id) return;
  const rec = snap.models[id];
  if (!rec) return;
  post({
    type: "progress",
    message:
      rec.fromCache === true
        ? "Loading speech model from cache…"
        : "Downloading speech model…",
    value: rec.indeterminate ? null : rec.percent,
  });
});

/**
 * The aligner gets its own registry rather than joining `models`.
 *
 * It is a different family — an acoustic aligner, not a transcriber, and not
 * something the user picks — but the deciding factor is lifecycle. The ASR
 * registry exists under a WebGPU→WASM fallback policy whose recovery step is
 * `unloadAll()`. The aligner never asks for a device, so transformers.js runs it
 * on WASM (`DEFAULT_DEVICE`), where a lost GPU cannot touch it. Sharing the
 * registry meant a GPU loss threw away 86 MB that was still perfectly good.
 */
const aligners = new ModelManager({ models: { [ALIGN_MODEL]: alignerModel() } });

async function getAsr(choice: WhisperModel) {
  return models.load<AutomaticSpeechRecognitionPipeline>(MODELS[choice].id);
}

async function getParakeet() {
  return models.load<ParakeetInstance>(MODELS.parakeet.id);
}

/**
 * Drop dead WebGPU pipelines and reload on WASM.
 * A lost GPU device invalidates every WebGPU session, so clear the whole
 * ASR cache — not just the model that was running. The aligner is a separate
 * registry and runs on WASM, so it is deliberately untouched.
 */
async function fallbackAsrToWasm() {
  fallbackDevicePolicy.preferWasm();
  asrDevice = "wasm";
  await models.unloadAll();
  post({
    type: "progress",
    message: "GPU interrupted — continuing on CPU…",
    value: null,
  });
}

/**
 * Build decoder input tokens implementing Whisper's "initial prompt"
 * conditioning: `<|startofprev|> …prompt… <|startoftranscript|> <|lang|>
 * <|transcribe|>`. transformers.js documents `prompt_ids` but does not
 * implement it, so the tokens are constructed manually and passed as
 * `decoder_input_ids` (which `generate` honors for every chunk). Returns
 * null if any required token cannot be resolved.
 */
function buildPromptedDecoderIds(
  transcriber: AutomaticSpeechRecognitionPipeline,
  prompt: string,
  language: string
): number[] | null {
  try {
    // Tokenizer/config internals are untyped in transformers.js.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const tokenizer = transcriber.tokenizer as any;
    const genCfg = (transcriber.model as any).generation_config;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const startOfPrev = tokenizer.encode("<|startofprev|>", { add_special_tokens: false });
    const promptIds = tokenizer.encode(" " + prompt.trim(), { add_special_tokens: false });
    const startId = genCfg?.decoder_start_token_id;
    const langId = genCfg?.lang_to_id?.[`<|${language}|>`];
    const taskId = genCfg?.task_to_id?.["transcribe"];
    if (
      startOfPrev?.length !== 1 ||
      !promptIds?.length ||
      startId == null ||
      langId == null ||
      taskId == null
    ) {
      return null;
    }
    return [startOfPrev[0], ...promptIds, startId, langId, taskId];
  } catch {
    return null;
  }
}

interface DiarizationSegment {
  id: number;
  start: number;
  end: number;
  confidence: number;
}

type Aligner = {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForCTC.from_pretrained>>;
  vocab: CtcVocab;
};

type Diarizer = {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForAudioFrameClassification.from_pretrained>>;
};

/**
 * Silero VAD: ~2 MB ONNX model that scores speech probability per 32 ms frame.
 * Used to find speech segments so Whisper never decodes long silence.
 * Falls back to energy VAD on failure.
 */
type VadModel = {
  (inputs: {
    input: InstanceType<typeof Tensor>;
    sr: InstanceType<typeof Tensor>;
    state: InstanceType<typeof Tensor>;
  }): Promise<{
    output: { data: ArrayLike<number> };
    stateN: InstanceType<typeof Tensor>;
  }>;
};

let vadPromise: Promise<VadModel | null> | null = null;
function getVad(): Promise<VadModel | null> {
  if (!vadPromise) {
    vadPromise = AutoModel.from_pretrained(VAD_MODEL, {
      // Silero ships as a custom ONNX graph without a transformers config.
      // @ts-expect-error transformers.js accepts model_type via config override
      config: { model_type: "custom" },
      dtype: "fp32",
    })
      .then((model) => model as unknown as VadModel)
      .catch((err) => {
        console.warn("Silero VAD failed to load; using energy-based silence detection.", err);
        return null;
      });
  }
  return vadPromise;
}

async function speechFramesWithSilero(
  model: VadModel,
  audio: Float32Array
): Promise<boolean[]> {
  const frameSize = VAD_FRAME_SIZE;
  const n = Math.ceil(audio.length / frameSize) || 0;
  const out: boolean[] = new Array(n);
  const sr = new Tensor("int64", [BigInt(VAD_SAMPLE_RATE)], []);
  let state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  // Fresh buffer each frame so ORT never sees a mutated shared view.
  const threshold = 0.35;

  for (let f = 0; f < n; f++) {
    const start = f * frameSize;
    const end = Math.min(audio.length, start + frameSize);
    const frameBuf = new Float32Array(frameSize);
    frameBuf.set(audio.subarray(start, end));
    const input = new Tensor("float32", frameBuf, [1, frameSize]);
    const { output, stateN } = await model({ input, sr, state });
    state = stateN;
    out[f] = Number(output.data[0] ?? 0) >= threshold;

    if (f > 0 && f % 512 === 0) {
      post({ type: "progress", message: "Detecting speech…", value: f / n });
    }
  }
  return out;
}

/** Turn speech-frame flags into segments, with a full-audio fallback. */
function segmentsOrFull(
  frames: boolean[],
  audio: Float32Array
): SpeechSegment[] {
  const segments = speechSegmentsFromFrames(frames, audio.length, {
    maxGapS: SPEECH_MAX_GAP_S,
    padS: SPEECH_PAD_S,
  });
  if (segments.length > 0) return segments;
  console.warn("VAD found no speech; falling back to full audio.");
  return [{ startSample: 0, endSample: audio.length }];
}

/**
 * Speech segments to transcribe, plus the raw per-frame flags they came from.
 * The flags are kept because word timestamps are realigned against them once
 * decoding finishes (see lib/align.ts); `frames` is empty when detection failed
 * and the whole file is decoded as one segment, which makes that step a no-op.
 */
async function detectSpeechSegments(
  audio: Float32Array,
  vad: VadModel | null
): Promise<{ segments: SpeechSegment[]; frames: boolean[] }> {
  try {
    const frames = vad
      ? await speechFramesWithSilero(vad, audio)
      : energySpeechFrames(audio);
    return { segments: segmentsOrFull(frames, audio), frames };
  } catch (err) {
    console.warn("Speech segmentation failed; falling back to full audio.", err);
    return { segments: [{ startSample: 0, endSample: audio.length }], frames: [] };
  }
}

/** Nominal length given to a word whose end timestamp is missing or unusable. */
const FALLBACK_WORD_S = 0.5;

/** Map Whisper word chunks from a segment onto the original media timeline. */
function wordsFromChunks(
  chunks: AsrChunk[],
  offsetS: number,
  segmentDuration: number,
  mediaDuration: number
): Word[] {
  const clampLocal = (t: number) => Math.min(Math.max(t, 0), segmentDuration);
  const usable = chunks
    .map((c) => ({ text: c.text.trim(), timestamp: c.timestamp }))
    .filter((c) => c.text.length > 0);

  return usable.map((c, i) => {
    const localStart = clampLocal(c.timestamp[0] ?? 0);
    // Word timestamps come from DTW over the encoder's cross-attention, and
    // that window is always the full 30 s zero-padded input — so the last word
    // of a short slice regularly comes back ending at ~29.98 s no matter how
    // little audio there was. An end past the slice is not a long word, it is a
    // missing timestamp: fall back to a nominal length, bounded by the next
    // word. (Clamping to the media duration instead once produced a single
    // 13.7 s "word" covering the whole tail of the timeline.)
    const next = usable[i + 1];
    const nextStart = next
      ? clampLocal(next.timestamp[0] ?? segmentDuration)
      : segmentDuration;
    const rawEnd = c.timestamp[1];
    const localEnd =
      rawEnd != null && rawEnd <= segmentDuration
        ? clampLocal(rawEnd)
        : Math.min(localStart + FALLBACK_WORD_S, Math.max(localStart, nextStart));

    let start = offsetS + localStart;
    let end = offsetS + Math.max(localEnd, localStart);
    if (mediaDuration > 0) {
      start = Math.min(start, mediaDuration);
      end = Math.min(end, mediaDuration);
    }
    start = Math.max(0, start);
    return {
      id: i,
      text: c.text,
      start,
      end: Math.max(end, start + 0.02),
      speaker: 0,
      deleted: false,
    };
  });
}

/**
 * Load the diarization model. Started in the background while Whisper is
 * still transcribing, so the (small) speaker model is downloaded, cached,
 * and ready by the time the transcript lands — closing the tab right after
 * transcription no longer leaves it uncached for the next session. No
 * progress is posted here to avoid interleaving with transcription progress.
 */
let diarizerPromise: Promise<Diarizer> | null = null;
function getDiarizer(): Promise<Diarizer> {
  if (!diarizerPromise) {
    diarizerPromise = (async () => {
      const processor = await AutoProcessor.from_pretrained(DIARIZATION_MODEL, {});
      const model = await AutoModelForAudioFrameClassification.from_pretrained(
        DIARIZATION_MODEL,
        { dtype: "fp32" }
      );
      return { processor, model };
    })();
    diarizerPromise.catch(() => {
      diarizerPromise = null;
    });
  }
  return diarizerPromise;
}

/**
 * The CTC acoustic model that places word boundaries, as a weightlift
 * definition so its bytes are tracked like the ASR models rather than
 * downloading silently behind an "Aligning words…" label.
 *
 * Not `transformersModel()`: that builds a `pipeline()`, and this needs the
 * processor, model and tokenizer separately. The progress wiring is the same.
 *
 * q4 is 86 MB against fp32's 360 MB and scored identically on the test clip
 * (0.033 s mean boundary error). q8 is no smaller and markedly worse — it moved
 * one word 0.22 s — and fp16 fails to load on onnxruntime-web.
 */
function alignerModel(): ModelDefinition<Aligner> {
  return {
    isCached: () =>
      isTransformersModelCached(ALIGN_MODEL, {
        cacheKey: env.cacheKey ?? "transformers-cache",
      }),
    load: async ({ progress }) => {
      const progress_callback = transformersProgress(progress);
      const [processor, model, tokenizer] = await Promise.all([
        AutoProcessor.from_pretrained(ALIGN_MODEL, { progress_callback }),
        AutoModelForCTC.from_pretrained(ALIGN_MODEL, {
          dtype: "q4",
          progress_callback,
        }),
        AutoTokenizer.from_pretrained(ALIGN_MODEL, { progress_callback }),
      ]);
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const tok = tokenizer as any;
      const vocab: CtcVocab = {
        blankId: tok.pad_token_id ?? 0,
        delimiterId: ALIGN_DELIMITER_ID,
        encode: (text) =>
          text ? (tok.encode(text, { add_special_tokens: false }) as number[]) : [],
      };
      return { processor, model, vocab };
    },
  };
}

function getAligner(): Promise<Aligner> {
  return aligners.load<Aligner>(ALIGN_MODEL);
}

/** Per-frame log-probabilities for one slice of audio. */
async function ctcEmission(aligner: Aligner, slice: Float32Array): Promise<CtcEmission> {
  const inputs = await aligner.processor(slice);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const { logits } = await (aligner.model as any)(inputs);
  const [, frames, vocab] = logits.dims as number[];
  const data = logits.data as Float32Array;
  // The model emits raw scores; Viterbi needs log-probabilities.
  const logProbs = new Float32Array(frames * vocab);
  for (let t = 0; t < frames; t++) {
    const row = t * vocab;
    let max = -Infinity;
    for (let v = 0; v < vocab; v++) if (data[row + v] > max) max = data[row + v];
    let sum = 0;
    for (let v = 0; v < vocab; v++) sum += Math.exp(data[row + v] - max);
    const logSumExp = max + Math.log(sum);
    for (let v = 0; v < vocab; v++) logProbs[row + v] = data[row + v] - logSumExp;
  }
  return { logProbs, frames, vocab };
}

/**
 * Replace Whisper's word timings with boundaries measured against the audio.
 *
 * Whisper's own timestamps come from DTW over cross-attention and are only
 * roughly right; they are used here just to decide which words go in which
 * batch. Any batch that fails to align keeps the timings it came in with, so a
 * bad slice costs accuracy on those words rather than losing them.
 */
async function forceAlign(
  words: Word[],
  audio: Float32Array,
  duration: number
): Promise<Word[]> {
  // Subscribe only while we are actually waiting. The aligner also warms in the
  // background during transcription, and those bytes must not fight the
  // "Transcribing…" line — but a wait here is worth a bar, since a cold cache
  // otherwise looks like a hang. Scoping the subscription to the await is the
  // whole gate: no shared flag to get out of step if this is ever re-entered.
  let aligner: Aligner;
  const unsubscribe = aligners.subscribe((snap) => {
    const rec = snap.models[ALIGN_MODEL];
    if (!rec || rec.status !== "loading") return;
    post({
      type: "progress",
      message:
        rec.fromCache === true
          ? "Loading alignment model from cache…"
          : "Downloading alignment model…",
      value: rec.indeterminate ? null : rec.percent,
    });
  });
  try {
    aligner = await getAligner();
  } finally {
    unsubscribe();
  }
  // Switch off the download label as soon as the weights are in hand.
  post({ type: "progress", message: "Aligning words…", value: 0 });
  const batches = groupWordsForAlignment(words, ALIGN_BATCH_MAX_S);
  const out: Word[] = [];
  let done = 0;

  for (const batch of batches) {
    const from = Math.max(0, batch[0].start - ALIGN_BATCH_PAD_S);
    const to = Math.min(duration, batch[batch.length - 1].end + ALIGN_BATCH_PAD_S);
    const startSample = Math.floor(from * VAD_SAMPLE_RATE);
    const endSample = Math.min(audio.length, Math.ceil(to * VAD_SAMPLE_RATE));
    const slice = audio.slice(startSample, endSample);
    let aligned: Word[] | null = null;
    if (slice.length > VAD_SAMPLE_RATE / 10) {
      try {
        const emission = await ctcEmission(aligner, slice);
        aligned = alignBatch(
          batch,
          emission,
          startSample / VAD_SAMPLE_RATE,
          slice.length / VAD_SAMPLE_RATE,
          aligner.vocab
        );
      } catch (err) {
        console.warn("Forced alignment failed for one batch; keeping decoded times.", err);
      }
    }
    out.push(...(aligned ?? batch));
    done++;
    post({ type: "progress", message: "Aligning words…", value: done / batches.length });
  }
  return out;
}

async function diarize(audio: Float32Array): Promise<DiarizationSegment[]> {
  const { processor, model } = await getDiarizer();
  const inputs = await processor(audio);
  const { logits } = await model(inputs);
  // post_process_speaker_diarization is specific to the PyAnnote processor
  // and is not part of the generic Processor typings.
  const pyannote = processor as unknown as {
    post_process_speaker_diarization: (
      logits: unknown,
      numSamples: number
    ) => DiarizationSegment[][];
  };
  const result = pyannote.post_process_speaker_diarization(logits, audio.length);
  return result[0] ?? [];
}

/** Assign a speaker to each word from the diarization segments. */
function assignSpeakers(words: Word[], segments: DiarizationSegment[]) {
  // Segment id 0 is "no speaker" (silence/noise); ignore it.
  const speech = segments.filter((s) => s.id !== 0);
  if (speech.length === 0) {
    for (const w of words) w.speaker = 0;
    return;
  }
  const idMap = new Map<number, number>(); // pyannote id -> sequential index
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    let seg = speech.find((s) => mid >= s.start && mid < s.end);
    if (!seg) {
      // Fall back to the nearest speech segment.
      let best = Infinity;
      for (const s of speech) {
        const d = mid < s.start ? s.start - mid : mid - s.end;
        if (d < best) {
          best = d;
          seg = s;
        }
      }
    }
    const raw = seg ? seg.id : -1;
    if (raw >= 0 && !idMap.has(raw)) idMap.set(raw, idMap.size);
    w.speaker = raw >= 0 ? (idMap.get(raw) as number) : 0;
  }
}

/** Map Parakeet word timestamps onto the original media timeline. */
function wordsFromParakeet(
  words: Array<{ text: string; start_time: number; end_time: number }>,
  offsetS: number,
  segmentDuration: number,
  mediaDuration: number
): Word[] {
  const clampLocal = (t: number) => Math.min(Math.max(t, 0), segmentDuration);
  const usable = words
    .map((w) => ({
      text: w.text.trim(),
      start: w.start_time,
      end: w.end_time,
    }))
    .filter((w) => w.text.length > 0);

  return usable.map((w, i) => {
    const localStart = clampLocal(w.start);
    const next = usable[i + 1];
    const nextStart = next ? clampLocal(next.start) : segmentDuration;
    const localEnd =
      Number.isFinite(w.end) && w.end <= segmentDuration + 0.05
        ? clampLocal(w.end)
        : Math.min(localStart + FALLBACK_WORD_S, Math.max(localStart, nextStart));

    let start = offsetS + localStart;
    let end = offsetS + Math.max(localEnd, localStart);
    if (mediaDuration > 0) {
      start = Math.min(start, mediaDuration);
      end = Math.min(end, mediaDuration);
    }
    start = Math.max(0, start);
    return {
      id: i,
      text: w.text,
      start,
      end: Math.max(end, start + 0.02),
      speaker: 0,
      deleted: false,
    };
  });
}

async function finishWithDiarization(
  words: Word[],
  audio: Float32Array
): Promise<Word[]> {
  try {
    post({ type: "progress", message: "Identifying speakers…", value: null });
    const segments = await diarize(audio);
    assignSpeakers(words, segments);
  } catch (err) {
    console.warn("Speaker diarization failed; using a single speaker.", err);
  }
  return words;
}

async function runParakeet(
  audio: Float32Array,
  duration: number
): Promise<Word[]> {
  getDiarizer().catch(() => {});
  const [loaded, vad] = await Promise.all([getParakeet(), getVad()]);
  let model = loaded;

  post({ type: "progress", message: "Detecting speech…", value: 0 });
  const { segments: speechSegments, frames: speechFrames } =
    await detectSpeechSegments(audio, vad);

  post({ type: "progress", message: "Transcribing…", value: 0 });
  const speechSamples = speechSegments.reduce(
    (n, s) => n + (s.endSample - s.startSample),
    0
  );

  const rawWords: Word[] = [];
  let partial = "";
  let speechDone = 0;

  for (const seg of speechSegments) {
    const segmentSamples = seg.endSample - seg.startSample;
    // Fresh buffer: non-zero byteOffset views have caused incomplete ASR with
    // onnxruntime-web in the Whisper path; keep the same hygiene here.
    const slice = audio.slice(seg.startSample, seg.endSample);
    const sliceDuration = slice.length / VAD_SAMPLE_RATE;
    const offsetS = seg.startSample / VAD_SAMPLE_RATE;

    const runSlice = () =>
      model.transcribe(slice, VAD_SAMPLE_RATE, {
        returnTimestamps: true,
        timeOffset: 0,
      });

    let result: Awaited<ReturnType<ParakeetInstance["transcribe"]>>;
    try {
      result = await runSlice();
    } catch (err) {
      if (asrDevice !== "webgpu" || !isWebGpuDeviceLostError(err)) {
        throw err;
      }
      console.warn(
        "WebGPU lost during Parakeet transcription; reloading on WASM.",
        err
      );
      await fallbackAsrToWasm();
      model = await getParakeet();
      result = await runSlice();
    }

    rawWords.push(
      ...wordsFromParakeet(result.words ?? [], offsetS, sliceDuration, duration)
    );
    const piece = (result.utterance_text ?? "").trim();
    if (piece) {
      partial = partial ? `${partial} ${piece}` : piece;
      post({ type: "partial", text: partial });
    }

    speechDone += segmentSamples;
    const value =
      speechSamples > 0 ? Math.min(1, speechDone / speechSamples) : 1;
    post({ type: "progress", message: "Transcribing…", value });
  }

  const cleaned = cleanTranscript(rawWords);
  // Same "..." filled-pause recovery as Whisper (no timestamp align for Parakeet).
  const words = insertDisfluencyPlaceholders(cleaned, speechFrames, { duration });
  return finishWithDiarization(words, audio);
}

async function runWhisper(
  audio: Float32Array,
  duration: number,
  choice: WhisperModel,
  transcriptLanguage: WorkerRequest["language"]
): Promise<Word[]> {
  // Overlap Whisper + Silero downloads; diarizer and aligner warm in the
  // background so both are cached by the time the transcript lands.
  getDiarizer().catch(() => {});
  getAligner().catch(() => {});
  const [asr, vad] = await Promise.all([getAsr(choice), getVad()]);
  let transcriber = asr;

  post({ type: "progress", message: "Detecting speech…", value: 0 });
  const { segments: speechSegments, frames: speechFrames } =
    await detectSpeechSegments(audio, vad);

  // Short filler-rich <|startofprev|> prompt so um/uh survive for "Remove
  // fillers". Long prompts truncate multi-speaker clips — see whisperFillerPrompt.
  const fillerPrompt = whisperFillerPrompt(choice, transcriptLanguage);
  const promptedIds = fillerPrompt
    ? buildPromptedDecoderIds(transcriber, fillerPrompt, transcriptLanguage)
    : null;
  if (fillerPrompt && !promptedIds) {
    console.warn("Could not build filler prompt tokens; using default decoding.");
  }

  const speechSamples = speechSegments.reduce(
    (n, s) => n + (s.endSample - s.startSample),
    0
  );

  post({ type: "progress", message: "Transcribing…", value: 0 });

  let partial = "";
  // Use 29s instead of 30: transformers.js has a known word-timestamp bug
  // at exactly chunk_length_s=30 (#1357 / #1358); 29 is the common workaround.
  const chunkLength = 29;
  const stride = 5;
  const timePrecision =
    // @ts-expect-error feature_extractor config is untyped
    (transcriber.processor.feature_extractor.config.chunk_length ?? 30) /
    // @ts-expect-error model config is untyped
    (transcriber.model.config.max_source_positions ?? 1500);

  let speechDone = 0;
  let transcribed = 0;
  let chunkFloor = 0;
  let chunkTokens = 0;
  let avgChunkDelta =
    speechSamples > 0
      ? Math.min(0.15, ((chunkLength - stride) * VAD_SAMPLE_RATE) / speechSamples)
      : 0.05;

  const reportProgress = (segmentLocalT: number, segmentSamples: number) => {
    const local = Math.min(
      segmentSamples,
      Math.max(0, segmentLocalT * VAD_SAMPLE_RATE)
    );
    const next = Math.max(
      transcribed,
      Math.min(1, speechSamples > 0 ? (speechDone + local) / speechSamples : 1)
    );
    const realDelta = next - chunkFloor;
    if (realDelta > 0) avgChunkDelta = avgChunkDelta * 0.5 + realDelta * 0.5;
    chunkFloor = next;
    chunkTokens = 0;
    transcribed = next;
    post({ type: "progress", message: "Transcribing…", value: transcribed });
  };

  /** Nudge the bar forward between chunk boundaries as tokens stream in. */
  const interpolateProgress = () => {
    chunkTokens++;
    // n/(n+8): 0.11 at token 1, 0.5 at token 8, 0.9 at token 72 — strictly
    // increasing, so it can never get stuck as long as tokens keep coming.
    const frac = chunkTokens / (chunkTokens + 8);
    const interpolated = Math.min(0.999, chunkFloor + frac * avgChunkDelta);
    if (interpolated > transcribed) {
      transcribed = interpolated;
      post({ type: "progress", message: "Transcribing…", value: transcribed });
    }
  };

  const asrOptions = {
    chunk_length_s: chunkLength,
    stride_length_s: stride,
    return_timestamps: "word" as const,
    // Anti-repetition: Whisper-base on multi-minute audio often falls into
    // loops like "little bit of a little bit of a…" near chunk boundaries
    // or silence. Keep penalty mild — 1.15 truncates multi-speaker clips
    // mid-utterance (second speaker dropped on continuous speech).
    no_repeat_ngram_size: 4,
    repetition_penalty: 1.05,
    ...(promptedIds
      ? { decoder_input_ids: promptedIds }
      : { language: transcriptLanguage }),
  };

  const rawWords: Word[] = [];
  const leadPadSamples = Math.floor(WHISPER_LEAD_PAD_S * VAD_SAMPLE_RATE);
  for (const seg of speechSegments) {
    const segmentSamples = seg.endSample - seg.startSample;
    // Copy into a fresh buffer with leading silence. Views with a non-zero
    // byteOffset have caused incomplete ASR with onnxruntime-web; starting
    // mid-speech with no lead-in also drops later speakers on mixed clips.
    const slice = new Float32Array(leadPadSamples + segmentSamples);
    slice.set(audio.subarray(seg.startSample, seg.endSample), leadPadSamples);
    const sliceDuration = slice.length / VAD_SAMPLE_RATE;
    const offsetS = seg.startSample / VAD_SAMPLE_RATE - WHISPER_LEAD_PAD_S;

    // Snapshot progress so a failed WebGPU attempt can be rolled back before
    // the WASM retry of this same segment.
    const partialBefore = partial;
    const progressBefore = { transcribed, chunkFloor, chunkTokens };

    const runSlice = async () => {
      // Each generate() window consumes `chunkLength - 2 * stride` seconds of
      // new audio, and the streamer's timestamps rewind to ~0 when the next
      // window starts. A timestamp lower than the last one seen marks that
      // boundary; accumulate the offset to recover segment-local time.
      const windowJumpS = chunkLength - 2 * stride;
      let windowOffsetS = 0;
      let lastChunkStartT = 0;
      const tokenizer = transcriber.tokenizer as ConstructorParameters<
        typeof WhisperTextStreamer
      >[0];
      const streamer = new WhisperTextStreamer(tokenizer, {
        skip_prompt: true,
        time_precision: timePrecision,
        on_chunk_start: (t: number) => {
          if (t < lastChunkStartT) windowOffsetS += windowJumpS;
          lastChunkStartT = t;
          reportProgress(
            Math.max(0, windowOffsetS + t - WHISPER_LEAD_PAD_S),
            segmentSamples
          );
        },
        callback_function: (text: string) => {
          partial += text;
          post({ type: "partial", text: partial });
          interpolateProgress();
        },
      });
      const output = await transcriber(slice, { ...asrOptions, streamer });
      const result = Array.isArray(output) ? output[0] : output;
      return (result.chunks ?? []) as AsrChunk[];
    };

    let chunks: AsrChunk[];
    try {
      chunks = await runSlice();
    } catch (err) {
      // Windows screen lock tears down WebGPU mid-OrtRun. Fall back to WASM
      // and retry this segment once so the job can finish.
      if (asrDevice !== "webgpu" || !isWebGpuDeviceLostError(err)) throw err;
      console.warn(
        "WebGPU lost during transcription (often after screen lock); falling back to WASM.",
        err
      );
      partial = partialBefore;
      transcribed = progressBefore.transcribed;
      chunkFloor = progressBefore.chunkFloor;
      chunkTokens = progressBefore.chunkTokens;
      post({ type: "partial", text: partial });
      await fallbackAsrToWasm();
      transcriber = await getAsr(choice);
      chunks = await runSlice();
    }

    rawWords.push(...wordsFromChunks(chunks, offsetS, sliceDuration, duration));
    speechDone += segmentSamples;
    reportProgress(0, 0);
  }

  // Post-process: collapse leftover n-gram loops and drop known hallucination
  // phrases ("I'm sorry", "thanks for watching", …) that slip past decoding.
  const cleaned = cleanTranscript(rawWords);

  // Whisper's DTW word timestamps run late by an amount that drifts across the
  // clip. Correct them against the VAD as a first pass: forced alignment only
  // needs them accurate enough to batch by, and this is what we fall back to if
  // the acoustic model is unavailable.
  let words = alignWordsToSpeech(cleaned, speechFrames, {
    duration,
    audio,
    sampleRate: VAD_SAMPLE_RATE,
  });

  // Then measure the boundaries properly. CTC forced alignment decides which
  // audio each word occupies; the envelope sharpens the edges, which CTC leaves
  // narrow because its emissions spike on each character and go blank around it.
  try {
    const measured = await forceAlign(words, audio, duration);
    words = expandToAcoustics(measured, speechEnvelope(audio, VAD_SAMPLE_RATE));
  } catch (err) {
    console.warn("Forced alignment unavailable; using VAD-corrected times.", err);
  }

  // Recover filled pauses Whisper omitted as "..." so Remove fillers can cut
  // them. After alignment, not before: this looks for speech no word covers, so
  // it needs the measured boundaries — and a "..." has no spelling for CTC, so
  // aligning it would only interpolate the placeholder away again.
  words = insertDisfluencyPlaceholders(words, speechFrames, { duration });

  return finishWithDiarization(words, audio);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { audio, duration, model, language } = event.data;
  try {
    const choice: ModelId = model ?? "base";
    const transcriptLanguage = language ?? "en";

    let words: Word[];
    if (isParakeetModel(choice)) {
      words = await runParakeet(audio, duration);
    } else if (isWhisperModel(choice)) {
      words = await runWhisper(audio, duration, choice, transcriptLanguage);
    } else {
      throw new Error(`Unknown speech model: ${String(choice)}`);
    }

    post({ type: "complete", words });
  } catch (err) {
    console.error(err);
    post({
      type: "error",
      message: isWebGpuDeviceLostError(err)
        ? "Transcription was interrupted when the GPU reset (often after locking the screen). Please try again."
        : err instanceof Error
          ? err.message
          : "Transcription failed.",
    });
  }
};
