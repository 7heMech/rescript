/**
 * Transcription worker: runs entirely in the browser.
 *
 * 1. A Whisper-family model (see lib/models.ts) produces a transcript with
 *    per-word timestamps.
 * 2. Pyannote segmentation 3.0 produces speaker segments, which are used to
 *    assign a speaker to each word.
 *
 * Models are fetched from the Hugging Face Hub on first use and cached in the
 * browser Cache Storage; every run after that is fully offline. The ONNX
 * runtime WASM binaries are served from /vendor/ort (same origin).
 */
import {
  pipeline,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
  WhisperTextStreamer,
  env,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type { Word, WorkerRequest, WorkerResponse } from "@/lib/types";
import { MODELS, type ModelChoice } from "@/lib/models";
import { cleanTranscript } from "@/lib/hallucinations";

env.allowLocalModels = false;
// Serve onnxruntime-web WASM from our own origin (offline friendly).
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/vendor/ort/`;
}

const DIARIZATION_MODEL = "onnx-community/pyannote-segmentation-3.0";

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

/**
 * Aggregate multi-file download progress into a single 0..1 value.
 *
 * Files are discovered progressively, so the naive loaded/total ratio can
 * *drop* whenever a new file starts reporting (the denominator suddenly
 * grows). The reported value is therefore clamped to be monotonically
 * increasing: it may pause while a newly discovered file catches up, but it
 * never goes backwards.
 */
function makeDownloadTracker(label: string) {
  const files = new Map<string, { loaded: number; total: number }>();
  let best = 0;
  return (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== "progress" || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    if (total === 0) return;
    best = Math.max(best, Math.min(1, loaded / total));
    post({ type: "progress", message: label, value: best });
  };
}

/**
 * Whether a model's weights are already in the transformers.js browser cache.
 * Used purely to label the progress UI accurately ("Loading … from cache"
 * instead of "Downloading …"): transformers.js emits identical progress
 * events when reading a cached model from disk as when downloading it.
 */
async function isModelCached(modelId: string): Promise<boolean> {
  try {
    const cache = await caches.open(env.cacheKey ?? "transformers-cache");
    const keys = await cache.keys();
    return keys.some((req) => req.url.includes(modelId) && req.url.includes(".onnx"));
  } catch {
    return false;
  }
}

async function pickDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const gpu = (globalThis.navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown | null> };
    })?.gpu;
    if (gpu && (await gpu.requestAdapter())) return "webgpu";
  } catch {
    // fall through to wasm
  }
  return "wasm";
}

// Keyed by model id: choices that share the same underlying model (e.g.
// "fast" and "verbatim", which differ only in prompting) share one pipeline.
const asrPromises = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();
async function getAsr(choice: ModelChoice) {
  const { id, dtype } = MODELS[choice];
  let promise = asrPromises.get(id);
  if (!promise) {
    const device = await pickDevice();
    const label = (await isModelCached(id))
      ? "Loading speech model from cache…"
      : "Downloading speech model…";
    promise = pipeline("automatic-speech-recognition", id, {
      dtype: dtype[device],
      device,
      progress_callback: makeDownloadTracker(label),
    }).catch((err) => {
      // WebGPU can fail on some drivers; retry once on plain WASM.
      if (device === "webgpu") {
        return pipeline("automatic-speech-recognition", id, {
          dtype: dtype.wasm,
          device: "wasm",
          progress_callback: makeDownloadTracker(label),
        });
      }
      throw err;
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
    asrPromises.set(id, promise);
    promise.catch(() => asrPromises.delete(id));
  }
  return promise;
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

type Diarizer = {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForAudioFrameClassification.from_pretrained>>;
};

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

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { audio, duration, model, language } = event.data;
  try {
    const choice = model ?? "fast";
    const transcriber = await getAsr(choice);

    const { verbatimPrompt } = MODELS[choice];
    const promptedIds = verbatimPrompt
      ? buildPromptedDecoderIds(transcriber, verbatimPrompt, language ?? "en")
      : null;
    if (verbatimPrompt && !promptedIds) {
      console.warn("Could not build verbatim prompt tokens; using default decoding.");
    }
    // Warm up the speaker model in parallel with transcription (errors are
    // handled when it is awaited later; this avoids an unhandled rejection).
    getDiarizer().catch(() => {});
    post({ type: "progress", message: "Transcribing…", value: 0 });

    let partial = "";
    const chunkLength = 30;
    const stride = 5;
    const timePrecision =
      // @ts-expect-error feature_extractor config is untyped
      (transcriber.processor.feature_extractor.config.chunk_length ?? 30) /
      // @ts-expect-error model config is untyped
      (transcriber.model.config.max_source_positions ?? 1500);

    const tokenizer = transcriber.tokenizer as ConstructorParameters<
      typeof WhisperTextStreamer
    >[0];
    // Chunk start times can jitter around stride boundaries; clamp the
    // reported transcription progress so it only ever moves forward.
    let transcribed = 0;
    const streamer = new WhisperTextStreamer(tokenizer, {
      skip_prompt: true,
      time_precision: timePrecision,
      on_chunk_start: (t: number) => {
        if (duration > 0) {
          transcribed = Math.max(transcribed, Math.min(1, t / duration));
        }
        post({
          type: "progress",
          message: "Transcribing…",
          value: duration > 0 ? transcribed : null,
        });
      },
      callback_function: (text: string) => {
        partial += text;
        post({ type: "partial", text: partial });
      },
    });

    const output = await transcriber(audio, {
      chunk_length_s: chunkLength,
      stride_length_s: stride,
      return_timestamps: "word",
      // Anti-repetition: Whisper-base on multi-minute audio often falls into
      // loops like "little bit of a little bit of a…" near chunk boundaries
      // or silence. These generation knobs cut that off at decode time.
      no_repeat_ngram_size: 4,
      repetition_penalty: 1.15,
      // decoder_input_ids overrides language/task tokens when prompting.
      ...(promptedIds ? { decoder_input_ids: promptedIds } : { language }),
      streamer,
    });

    const result = Array.isArray(output) ? output[0] : output;
    const chunks = (result.chunks ?? []) as {
      text: string;
      timestamp: [number, number | null];
    }[];

    const rawWords: Word[] = [];
    for (const c of chunks) {
      const text = c.text.trim();
      if (!text) continue;
      const start = c.timestamp[0] ?? 0;
      const end = c.timestamp[1] ?? Math.min(start + 0.5, duration || start + 0.5);
      rawWords.push({
        id: rawWords.length,
        text,
        start,
        end: Math.max(end, start + 0.02),
        speaker: 0,
        deleted: false,
      });
    }

    // Post-process: collapse leftover n-gram loops and drop known hallucination
    // phrases ("I'm sorry", "thanks for watching", …) that slip past decoding.
    const words = cleanTranscript(rawWords);

    // Best-effort speaker diarization; a failure should not lose the transcript.
    try {
      post({ type: "progress", message: "Identifying speakers…", value: null });
      const segments = await diarize(audio);
      assignSpeakers(words, segments);
    } catch (err) {
      console.warn("Speaker diarization failed; using a single speaker.", err);
    }

    post({ type: "complete", words });
  } catch (err) {
    console.error(err);
    post({
      type: "error",
      message: err instanceof Error ? err.message : "Transcription failed.",
    });
  }
};
