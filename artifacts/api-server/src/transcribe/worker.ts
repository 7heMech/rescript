/**
 * Node worker thread that runs Whisper speech-to-text on the CPU.
 *
 * This mirrors the browser worker (artifacts/rescript/src/workers) but stripped
 * to the server's job: decode the uploaded media to 16 kHz mono PCM with a
 * spawned ffmpeg, run the patched @huggingface/transformers pipeline with
 * word-level timestamps, and stream progress + the final word list back to the
 * main thread over the parentPort channel.
 *
 * It deliberately does NOT do VAD, forced alignment, or diarization: those live
 * in the browser worker where the aligner/diarizer models already ship. The
 * server path trades that refinement for not pinning a machine's GPU, and every
 * returned word gets speaker -1 (unknown), which the editor renders as a single
 * speaker.
 */
import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { pipeline, env, WhisperTextStreamer } from "@huggingface/transformers";
import type {
  AutomaticSpeechRecognitionPipeline,
  ProgressCallback,
  ProgressInfo,
  WhisperTokenizer,
} from "@huggingface/transformers";

interface CompleteWord {
  id: number;
  text: string;
  start: number;
  end: number;
  speaker: number;
  deleted: boolean;
}

/** Sample rate every Whisper export expects. */
const SAMPLE_RATE = 16000;

interface WorkerData {
  filePath: string;
  modelId: string;
  language: string;
  cacheDir: string;
}

/** Progress / partial / result / error messages posted to the parent. */
type OutMessage =
  | { type: "progress"; message: string; value: number | null }
  | { type: "partial"; text: string }
  | {
      type: "complete";
      words: {
        id: number;
        text: string;
        start: number;
        end: number;
        speaker: number;
        deleted: boolean;
      }[];
    }
  | { type: "error"; message: string; cause?: "network" };

const port = parentPort;
if (!port) {
  throw new Error("transcribe worker must run as a worker thread");
}

function post(msg: OutMessage): void {
  port!.postMessage(msg);
}

/**
 * Progress-message keys, matched to the browser worker's i18n keys so the
 * frontend can localize server progress with the same `localizeRuntimeMessage`
 * path it already uses for the browser worker.
 */
const MSG = {
  loadingCache: "Loading cached speech model…",
  downloading: "Downloading speech model…",
  transcribing: "Transcribing…",
} as const;

/** Decode any media file to a mono float32 PCM array at 16 kHz via ffmpeg. */
function decodeToPcm(filePath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = [
      "-nostdin",
      "-i",
      filePath,
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-f",
      "f32le",
      "-",
    ];
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      // Keep only the tail; ffmpeg is chatty and we only want the failure line.
      stderr = (stderr + c.toString()).slice(-4000);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) {
        reject(new Error("Decoded audio was empty."));
        return;
      }
      // Copy into an aligned ArrayBuffer so the Float32 view is safe.
      const samples = new Float32Array(buf.length >> 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buf.readFloatLE(i * 4);
      }
      resolve(samples);
    });
  });
}

/** Whisper dtype per component — q4 decoder is the pair proven on Base/Small. */
const DTYPE = {
  encoder_model: "fp32",
  decoder_model_merged: "q4",
} as const;

let cachedPipeline: {
  modelId: string;
  asr: AutomaticSpeechRecognitionPipeline;
} | null = null;

function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network|socket hang up/i.test(
    msg,
  );
}

async function loadPipeline(
  modelId: string,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (cachedPipeline && cachedPipeline.modelId === modelId) {
    return cachedPipeline.asr;
  }
  // A different model was loaded before: drop it so we don't hold two in RAM.
  if (cachedPipeline) {
    await cachedPipeline.asr.dispose().catch(() => {});
    cachedPipeline = null;
  }

  let sawDownload = false;
  const progress_callback: ProgressCallback = (info: ProgressInfo) => {
    if (info.status === "progress" && "progress" in info) {
      sawDownload = true;
      post({
        type: "progress",
        message: MSG.downloading,
        value:
          typeof info.progress === "number"
            ? Math.min(1, info.progress / 100)
            : null,
      });
    }
  };

  post({
    type: "progress",
    message: MSG.loadingCache,
    value: null,
  });

  const asr = (await pipeline("automatic-speech-recognition", modelId, {
    dtype: DTYPE,
    device: "cpu",
    progress_callback,
  })) as AutomaticSpeechRecognitionPipeline;

  void sawDownload;
  cachedPipeline = { modelId, asr };
  return asr;
}

async function run(data: WorkerData): Promise<void> {
  env.allowLocalModels = false;
  env.cacheDir = data.cacheDir;

  const asr = await loadPipeline(data.modelId);
  const audio = await decodeToPcm(data.filePath);
  const durationS = audio.length / SAMPLE_RATE;

  post({ type: "progress", message: MSG.transcribing, value: 0 });

  // Coalesce partial text and progress; the streamer fires per token.
  let partial = "";
  const tokenizer = asr.tokenizer;

  const streamer = new WhisperTextStreamer(tokenizer as WhisperTokenizer, {
    skip_prompt: true,
    // Time seen so far drives a rough progress bar against total duration.
    on_chunk_start: (offsetSeconds: number) => {
      if (durationS > 0) {
        post({
          type: "progress",
          message: MSG.transcribing,
          value: Math.min(0.99, offsetSeconds / durationS),
        });
      }
    },
    callback_function: (text: string) => {
      partial += text;
      post({ type: "partial", text: partial });
    },
  });

  const output = (await asr(audio, {
    return_timestamps: "word",
    chunk_length_s: 30,
    stride_length_s: 5,
    language: data.language,
    task: "transcribe",
    streamer,
  })) as { chunks?: { text: string; timestamp: [number, number | null] }[] };

  const chunks = output.chunks ?? [];
  const words: CompleteWord[] = [];
  let id = 0;
  let lastEnd = 0;
  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    const start = c.timestamp[0] ?? lastEnd;
    const end = c.timestamp[1] ?? start;
    lastEnd = end;
    words.push({
      id: id++,
      text,
      start,
      end,
      speaker: -1,
      deleted: false,
    });
  }

  post({ type: "complete", words });
}

run(workerData as WorkerData).catch((err: unknown) => {
  post({
    type: "error",
    message: err instanceof Error ? err.message : String(err),
    cause: isNetworkError(err) ? "network" : undefined,
  });
});
