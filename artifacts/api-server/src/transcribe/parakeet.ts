/**
 * Server-side Parakeet TDT loader.
 *
 * parakeet.js is published as a browser library, but only its *loading* layer is
 * actually browser-bound. This module skips that layer and rebuilds it for Node:
 *
 * - `hub.js` caches weights in IndexedDB and hands ONNX Runtime a
 *   `URL.createObjectURL(blob)`. Here we stream the same files from the Hub onto
 *   disk under MODEL_CACHE_DIR and hand ORT a plain file path instead.
 * - `backend.js` (`initOrt`) hard-imports `onnxruntime-web` and reads
 *   `navigator` / `SharedArrayBuffer`. We never call it; we pass
 *   `onnxruntime-node` in directly.
 * - `ParakeetTokenizer.fromUrl` and `OnnxPreprocessor` both go through `fetch`
 *   and `initOrt`, so both are reimplemented below against the filesystem.
 *
 * What we do *not* reimplement is the part that matters: the TDT greedy decode
 * loop, the encoder frame transpose, word-timestamp assembly and the long-audio
 * window merger all live on `ParakeetModel`, whose constructor takes its
 * dependencies as arguments. Everything it touches at runtime is `ort.Tensor`
 * and `session.run()`, which are API-identical between onnxruntime-web and
 * onnxruntime-node — so the decoder runs unmodified, no library patch needed.
 *
 * Quantisation differs from the browser on purpose. The web worker pairs an int8
 * encoder with an fp16 decoder; fp16 is a poor fit for the ORT CPU provider,
 * which has no native fp16 kernels and emulates them with cast pairs. The fp32
 * decoder is only ~72 MB, so on a CPU server we take int8 encoder + fp32
 * decoder: same download order of magnitude, better accuracy, faster execution.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import * as ort from "onnxruntime-node";
import { ParakeetModel } from "parakeet.js";

/** Hugging Face repo holding the ONNX export used by both browser and server. */
const REPO_ID = "ysdede/parakeet-tdt-0.6b-v3-onnx";
const REVISION = "main";

/** Mel bins for the v3 export (`nemo128`). */
const N_MELS = 128;

/** Encoder subsampling factor and feature stride, per the v3 model config. */
const SUBSAMPLING = 8;
const WINDOW_STRIDE = 0.01;

/** parakeet.js quant → filename suffix, mirroring its hub naming. */
const QUANT_SUFFIX: Record<string, string> = {
  fp32: ".onnx",
  fp16: ".fp16.onnx",
  int8: ".int8.onnx",
};

type Quant = "fp32" | "fp16" | "int8";

function quantFromEnv(name: string, fallback: Quant): Quant {
  const raw = process.env[name];
  if (raw === "fp32" || raw === "fp16" || raw === "int8") return raw;
  return fallback;
}

/**
 * How many intra-op threads ORT may use. Defaults to the container's CPU count;
 * `TRANSCRIBE_CONCURRENCY` above 1 should be paired with a smaller value here so
 * two jobs do not each try to claim every core.
 */
function threadCount(): number {
  const raw = Number(process.env["PARAKEET_THREADS"]);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return Math.max(1, availableParallelism());
}

/**
 * Window length for long-form audio, in seconds. parakeet.js clamps this to
 * [20, 180]; the encoder's activation memory grows with the window, so on a
 * shared server the low end of that range is the safer default.
 */
export function chunkLengthS(): number {
  const raw = Number(process.env["PARAKEET_CHUNK_LENGTH_S"]);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 60;
}

export interface DownloadProgress {
  file: string;
  loaded: number;
  total: number;
}

/**
 * Stream one Hub file to `dir`, skipping the request when it is already cached.
 *
 * Downloads land on a `.part` file and are renamed only on success, so an
 * interrupted process can never leave a truncated ONNX file that would fail
 * session creation on the next run with a confusing parse error.
 */
async function fetchToDisk(
  dir: string,
  filename: string,
  onProgress?: (p: DownloadProgress) => void,
  optional = false,
): Promise<string | null> {
  const dest = path.join(dir, filename);
  const existing = await stat(dest).catch(() => null);
  if (existing?.isFile() && existing.size > 0) return dest;

  const url = `https://huggingface.co/${REPO_ID}/resolve/${REVISION}/${encodeURIComponent(filename)}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    if (optional && response.status === 404) return null;
    throw new Error(
      `Failed to download ${filename} from ${REPO_ID}: ${response.status} ${response.statusText}`,
    );
  }

  const total = Number(response.headers.get("content-length") ?? 0);
  let loaded = 0;
  const partial = `${dest}.part`;

  // Report at most once per megabyte: a 600 MB encoder would otherwise post
  // tens of thousands of messages across the worker channel.
  let nextReport = 0;
  const source = Readable.fromWeb(
    response.body as Parameters<typeof Readable.fromWeb>[0],
  );
  source.on("data", (chunk: Buffer) => {
    loaded += chunk.length;
    if (onProgress && loaded >= nextReport) {
      nextReport = loaded + 1024 * 1024;
      onProgress({ file: filename, loaded, total });
    }
  });

  try {
    await streamPipeline(source, createWriteStream(partial));
    await rename(partial, dest);
  } catch (err) {
    await unlink(partial).catch(() => {});
    throw err;
  }
  return dest;
}

/**
 * Vocabulary decoder for the Parakeet SentencePiece token list.
 *
 * Reimplements `ParakeetTokenizer` (which is fetch-only and not exported from
 * the package root) against a local file. `ParakeetModel` reads `id2token`,
 * `blankToken`, `blankId` and `decode`, so those four make up the contract.
 */
class FileTokenizer {
  readonly id2token: string[];
  readonly blankToken = "<blk>";
  readonly blankId: number;
  private readonly sanitized: string[];

  constructor(vocabText: string) {
    const id2token: string[] = [];
    for (const line of vocabText.split(/\r?\n/)) {
      if (!line) continue;
      const [token, idStr] = line.split(/\s+/);
      const id = Number.parseInt(idStr ?? "", 10);
      if (!token || Number.isNaN(id)) continue;
      id2token[id] = token;
    }
    this.id2token = id2token;
    const blank = id2token.indexOf(this.blankToken);
    this.blankId = blank === -1 ? 1024 : blank;
    // U+2581 (SentencePiece word marker) stands in for a leading space.
    this.sanitized = id2token.map((t) => (t ? t.replaceAll("\u2581", " ") : t));
  }

  decode(ids: number[]): string {
    const parts: string[] = [];
    for (const id of ids) {
      if (id === this.blankId) continue;
      const token = this.sanitized[id];
      if (token === undefined) continue;
      parts.push(token);
    }
    return parts
      .join("")
      .replace(/^\s+/, "")
      .replace(/\s+(?=[^\w\s])/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
}

/**
 * NeMo log-mel featuriser (`nemo128.onnx`) on onnxruntime-node.
 *
 * The pure-JS mel in `mel.js` would run in Node unchanged, but it is a
 * hand-written FFT and filterbank: any drift from NeMo's own features degrades
 * every downstream prediction in a way that reads as "the model got worse". The
 * browser worker already pays 0.1 MB to avoid that, and so do we.
 *
 * `ParakeetModel` only calls `process()`, and depends on `length` being the
 * *valid* frame count — which may be one less than the tensor's frame dimension
 * because of STFT padding. Both values are returned; the caller must not
 * truncate.
 */
class FilePreprocessor {
  private session: ort.InferenceSession | null = null;

  constructor(
    private readonly modelPath: string,
    private readonly threads: number,
  ) {}

  async init(): Promise<void> {
    this.session ??= await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: this.threads,
      logSeverityLevel: 2,
    });
  }

  async process(
    audio: Float32Array,
  ): Promise<{ features: Float32Array; length: number }> {
    await this.init();
    const session = this.session!;

    // A subarray view would hand ORT the whole backing buffer; copy unless the
    // input already owns its buffer outright.
    const isWholeBuffer =
      audio.byteOffset === 0 && audio.buffer.byteLength === audio.byteLength;
    const samples = isWholeBuffer ? audio : new Float32Array(audio);

    const waveforms = new ort.Tensor("float32", samples, [1, samples.length]);
    const waveformsLens = new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(samples.length)]),
      [1],
    );

    const outputs = await session.run({
      waveforms,
      waveforms_lens: waveformsLens,
    });
    const features = outputs["features"];
    const featureLens = outputs["features_lens"];
    if (!features || !featureLens) {
      throw new Error("Preprocessor returned no features.");
    }

    return {
      features: new Float32Array(features.data as Float32Array),
      length: Number(featureLens.data[0]),
    };
  }

  async release(): Promise<void> {
    await this.session?.release().catch(() => {});
    this.session = null;
  }
}

/**
 * The published `.d.ts` for `ParakeetModel` declares no constructor — only the
 * `fromUrls` factory, whose browser-only path we are deliberately avoiding. The
 * constructor is public and documented in JSDoc, so this narrows it back to the
 * shape `parakeet.js` actually accepts rather than widening anything to `any`.
 */
interface ParakeetDeps {
  tokenizer: FileTokenizer;
  encoderSession: ort.InferenceSession;
  joinerSession: ort.InferenceSession;
  preprocessor: FilePreprocessor;
  ort: typeof ort;
  subsampling?: number;
  windowStride?: number;
  nMels?: number;
}

const ParakeetModelCtor = ParakeetModel as unknown as new (
  deps: ParakeetDeps,
) => ParakeetModel;

export interface LoadedParakeet {
  model: ParakeetModel;
  /** Release both ONNX sessions and the preprocessor's. */
  dispose: () => Promise<void>;
}

export interface LoadParakeetOptions {
  /** Weight cache root; the same MODEL_CACHE_DIR the Whisper path uses. */
  cacheDir: string;
  /** Called while weights download. Not called on a warm cache. */
  onDownloadProgress?: (p: DownloadProgress) => void;
}

/**
 * Fetch (or reuse) the v3 weights and build a `ParakeetModel` on
 * onnxruntime-node.
 *
 * Weights live under `<cacheDir>/parakeet/<repo>/` and survive restarts, so the
 * ~700 MB download happens once per machine rather than once per job.
 */
export async function loadParakeet(
  options: LoadParakeetOptions,
): Promise<LoadedParakeet> {
  const encoderQuant = quantFromEnv("PARAKEET_ENCODER_QUANT", "int8");
  const decoderQuant = quantFromEnv("PARAKEET_DECODER_QUANT", "fp32");
  const encoderName = `encoder-model${QUANT_SUFFIX[encoderQuant]}`;
  const decoderName = `decoder_joint-model${QUANT_SUFFIX[decoderQuant]}`;

  const dir = path.join(
    options.cacheDir,
    "parakeet",
    REPO_ID.replaceAll("/", "--"),
  );
  await mkdir(dir, { recursive: true });

  const progress = options.onDownloadProgress;
  const encoderPath = await fetchToDisk(dir, encoderName, progress);
  const decoderPath = await fetchToDisk(dir, decoderName, progress);
  const preprocessorPath = await fetchToDisk(dir, "nemo128.onnx", progress);
  const vocabPath = await fetchToDisk(dir, "vocab.txt", progress);

  // Larger exports ship their weights in a `<model>.data` sidecar. ORT resolves
  // external data relative to the model file, so simply placing it alongside is
  // enough — no `externalData` session option, unlike the browser path which
  // must name it explicitly because blob URLs have no directory.
  await fetchToDisk(dir, `${encoderName}.data`, progress, true);
  await fetchToDisk(dir, `${decoderName}.data`, progress, true);

  if (!encoderPath || !decoderPath || !preprocessorPath || !vocabPath) {
    throw new Error("Parakeet weights are incomplete.");
  }

  const threads = threadCount();
  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
    // Sequential + intra-op threads, not the library's 'parallel': a Conformer
    // graph is a deep chain with little to run side by side, and inter-op
    // threads would only contend with the intra-op pool for the same cores.
    executionMode: "sequential",
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    logSeverityLevel: 2,
  };

  const [encoderSession, joinerSession] = await Promise.all([
    ort.InferenceSession.create(encoderPath, sessionOptions),
    ort.InferenceSession.create(decoderPath, sessionOptions),
  ]);

  const { readFile } = await import("node:fs/promises");
  const tokenizer = new FileTokenizer(await readFile(vocabPath, "utf8"));
  const preprocessor = new FilePreprocessor(preprocessorPath, threads);
  await preprocessor.init();

  const model = new ParakeetModelCtor({
    tokenizer,
    encoderSession,
    joinerSession,
    preprocessor,
    ort,
    subsampling: SUBSAMPLING,
    windowStride: WINDOW_STRIDE,
    nMels: N_MELS,
  });

  return {
    model,
    dispose: async () => {
      await Promise.all([
        encoderSession.release().catch(() => {}),
        joinerSession.release().catch(() => {}),
        preprocessor.release(),
      ]);
    },
  };
}

/**
 * Wrap an instance's `transcribe` so long-audio windowing reports progress.
 *
 * `transcribeLongAudio` does its own sentence-aware windowing and overlap merge,
 * but exposes no per-window callback — and `runAutoSentenceWindowing` is
 * internal. It does, however, drive everything through `model.transcribe()` with
 * the window's `timeOffset`, so wrapping that one method on the instance turns
 * each window into a progress tick without touching the library.
 *
 * Returns a restore function; the wrapper is per-instance, so a caller that
 * reuses a model across jobs must restore before rewrapping.
 */
export function observeWindows(
  model: ParakeetModel,
  onWindow: (endS: number, text: string) => void,
): () => void {
  const original = model.transcribe.bind(model);
  const patched: ParakeetModel["transcribe"] = async (audio, sampleRate, opts) => {
    const result = await original(audio, sampleRate, opts);
    const offset = opts?.timeOffset ?? 0;
    const windowS = audio ? audio.length / (sampleRate ?? 16000) : 0;
    onWindow(offset + windowS, result.utterance_text ?? "");
    return result;
  };
  model.transcribe = patched;
  return () => {
    model.transcribe = original;
  };
}
