/**
 * Node worker dedicated to Parakeet TDT v3.
 *
 * This is intentionally a separate esbuild entry from worker.ts. The Parakeet
 * loader imports onnxruntime-node, whose native addon must never be evaluated
 * by Whisper jobs.
 */
import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { chunkLengthS, loadParakeet, observeWindows } from "./parakeet";

const SAMPLE_RATE = 16000;
const MSG = {
  loadingCache: "Loading cached speech model…",
  downloading: "Downloading speech model…",
  transcribing: "Transcribing…",
} as const;

interface WorkerData {
  filePath: string;
  cacheDir: string;
}

interface CompleteWord {
  id: number;
  text: string;
  start: number;
  end: number;
  speaker: number;
  deleted: boolean;
}

type OutMessage =
  | { type: "progress"; message: string; value: number | null }
  | { type: "partial"; text: string }
  | { type: "complete"; words: CompleteWord[] }
  | { type: "error"; message: string; cause?: "network" };

const port = parentPort;
if (!port) {
  throw new Error("parakeet worker must run as a worker thread");
}

function post(message: OutMessage): void {
  port!.postMessage(message);
}

function decodeToPcm(filePath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
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
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4) {
        reject(new Error("Decoded audio was empty."));
        return;
      }
      const samples = new Float32Array(buffer.length >> 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buffer.readFloatLE(i * 4);
      }
      resolve(samples);
    });
  });
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network|socket hang up/i.test(
    message,
  );
}

async function run(data: WorkerData): Promise<void> {
  const audio = await decodeToPcm(data.filePath);
  const durationS = audio.length / SAMPLE_RATE;
  let sawDownload = false;
  const { model, dispose } = await loadParakeet({
    cacheDir: data.cacheDir,
    onDownloadProgress: ({ loaded, total }) => {
      sawDownload = true;
      post({
        type: "progress",
        message: MSG.downloading,
        value: total > 0 ? Math.min(1, loaded / total) : null,
      });
    },
  });
  if (!sawDownload) {
    post({ type: "progress", message: MSG.loadingCache, value: null });
  }

  post({ type: "progress", message: MSG.transcribing, value: 0 });
  let partial = "";
  const restore = observeWindows(model, (endS, text) => {
    const piece = text.trim();
    if (piece) {
      partial = partial ? `${partial} ${piece}` : piece;
      post({ type: "partial", text: partial });
    }
    if (durationS > 0) {
      post({
        type: "progress",
        message: MSG.transcribing,
        value: Math.min(0.99, endS / durationS),
      });
    }
  });

  try {
    const output = await model.transcribeLongAudio(audio, SAMPLE_RATE, {
      returnTimestamps: "word",
      chunkLengthS: chunkLengthS(),
    });
    const words: CompleteWord[] = [];
    let id = 0;
    let lastEnd = 0;
    for (const word of output.words ?? []) {
      const text = word.text.trim();
      if (!text) continue;
      const start = Number.isFinite(word.start_time) ? word.start_time : lastEnd;
      const end = Number.isFinite(word.end_time) ? word.end_time : start;
      lastEnd = end;
      words.push({
        id: id++,
        text,
        start: Math.max(0, start),
        end: Math.max(end, start + 0.02),
        speaker: -1,
        deleted: false,
      });
    }
    post({ type: "complete", words });
  } finally {
    restore();
    await dispose();
  }
}

function reportError(error: unknown): void {
  post({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
    cause: isNetworkError(error) ? "network" : undefined,
  });
}

const initialData = workerData as WorkerData & { persistent?: boolean };
if (initialData.persistent) {
  port.on("message", (message: WorkerData) => {
    void run(message).catch(reportError);
  });
} else {
  void run(initialData).catch(reportError);
}