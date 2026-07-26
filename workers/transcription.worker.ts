/**
 * Transcription worker: runs entirely in the browser.
 *
 * 1. Whisper (onnx-community/whisper-base_timestamped) produces a transcript
 *    with per-word timestamps.
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

env.allowLocalModels = false;
// Serve onnxruntime-web WASM from our own origin (offline friendly).
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = "/vendor/ort/";
}

const ASR_MODEL = "onnx-community/whisper-base_timestamped";
const DIARIZATION_MODEL = "onnx-community/pyannote-segmentation-3.0";

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

/** Aggregate multi-file download progress into a single 0..1 value. */
function makeDownloadTracker(label: string) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== "progress" || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    post({
      type: "progress",
      message: label,
      value: total > 0 ? loaded / total : null,
    });
  };
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

let asrPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
async function getAsr() {
  if (!asrPromise) {
    const device = await pickDevice();
    const dtype = { encoder_model: "fp32", decoder_model_merged: "q4" } as const;
    asrPromise = pipeline("automatic-speech-recognition", ASR_MODEL, {
      dtype,
      device,
      progress_callback: makeDownloadTracker("Downloading speech model…"),
    }).catch((err) => {
      // WebGPU can fail on some drivers; retry once on plain WASM.
      if (device === "webgpu") {
        return pipeline("automatic-speech-recognition", ASR_MODEL, {
          dtype,
          device: "wasm",
          progress_callback: makeDownloadTracker("Downloading speech model…"),
        });
      }
      throw err;
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
  }
  return asrPromise;
}

interface DiarizationSegment {
  id: number;
  start: number;
  end: number;
  confidence: number;
}

async function diarize(audio: Float32Array): Promise<DiarizationSegment[]> {
  const progress = makeDownloadTracker("Downloading speaker model…");
  const processor = await AutoProcessor.from_pretrained(DIARIZATION_MODEL, {
    progress_callback: progress,
  });
  const model = await AutoModelForAudioFrameClassification.from_pretrained(
    DIARIZATION_MODEL,
    { dtype: "fp32", progress_callback: progress }
  );
  post({ type: "progress", message: "Identifying speakers…", value: null });
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
  const { audio, duration, language } = event.data;
  try {
    const transcriber = await getAsr();
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
    const streamer = new WhisperTextStreamer(tokenizer, {
      skip_prompt: true,
      time_precision: timePrecision,
      on_chunk_start: (t: number) => {
        post({
          type: "progress",
          message: "Transcribing…",
          value: duration > 0 ? Math.min(1, t / duration) : null,
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
      language,
      streamer,
    });

    const result = Array.isArray(output) ? output[0] : output;
    const chunks = (result.chunks ?? []) as {
      text: string;
      timestamp: [number, number | null];
    }[];

    const words: Word[] = [];
    for (const c of chunks) {
      const text = c.text.trim();
      if (!text) continue;
      const start = c.timestamp[0] ?? 0;
      const end = c.timestamp[1] ?? Math.min(start + 0.5, duration || start + 0.5);
      words.push({
        id: words.length,
        text,
        start,
        end: Math.max(end, start + 0.02),
        speaker: 0,
        deleted: false,
      });
    }

    // Best-effort speaker diarization; a failure should not lose the transcript.
    try {
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
