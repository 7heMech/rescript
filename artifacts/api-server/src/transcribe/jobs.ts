/**
 * In-memory transcription job registry.
 *
 * Each job owns one uploaded media file and one worker thread. State is held in
 * a Map keyed by job id; there is no DB persistence because a transcript is a
 * one-shot result the client polls for and then owns. Jobs are reaped on a TTL
 * so a client that never polls the terminal state does not leak files or memory.
 *
 * Concurrency is bounded per model in the worker (the pipeline is cached there);
 * here we simply cap how many workers run at once so a burst of uploads does not
 * oversubscribe the CPU. Extra jobs wait in `queued` until a slot frees.
 */
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger";

export type JobState =
  | "queued"
  | "downloading"
  | "transcribing"
  | "done"
  | "error";

export interface JobWord {
  id: number;
  text: string;
  start: number;
  end: number;
  speaker: number;
  deleted: boolean;
}

interface WorkerOutMessage {
  type: "progress" | "partial" | "complete" | "error";
  message?: string;
  value?: number | null;
  text?: string;
  words?: JobWord[];
  cause?: "network";
}

export interface Job {
  id: string;
  state: JobState;
  /** Human-readable progress key (localized on the client). */
  message: string;
  /** 0..1 within the current stage, or null when indeterminate. */
  progress: number | null;
  words: JobWord[] | null;
  error: string | null;
  filePath: string;
  fileDir: string;
  modelId: string;
  backend: "whisper" | "parakeet";
  language: string;
  worker: Worker | null;
  admission: UploadAdmission;
  createdAt: number;
  updatedAt: number;
  /** Terminal time, used by the reaper's TTL. */
  finishedAt: number | null;
}

/** How many worker threads may run at once. */
const MAX_CONCURRENT = Number(process.env["TRANSCRIBE_CONCURRENCY"] ?? 1);

/** Maximum size of a single uploaded media file. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Bound disk reserved by queued/running uploads, not just active workers. */
const MAX_PENDING_JOBS = Number(
  process.env["TRANSCRIBE_MAX_PENDING_JOBS"] ?? 2,
);
const MAX_PENDING_UPLOAD_BYTES = Number(
  process.env["TRANSCRIBE_MAX_PENDING_BYTES"] ?? 4 * 1024 * 1024 * 1024,
);

/** How long a terminal job (and its transcript) is kept before reaping. */
const JOB_TTL_MS = 30 * 60 * 1000;

/** How long a job with no update at all may sit before it is force-reaped. */
const STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Model cache dir. Defaults under the user cache dir so downloaded weights
 * survive restarts and are not re-fetched per job.
 */
function modelCacheDir(): string {
  const configured = process.env["MODEL_CACHE_DIR"];
  if (configured) return configured;
  return path.join(homedir(), ".cache", "rescript-models");
}

const jobs = new Map<string, Job>();
const waiting: string[] = [];
interface BackendWorker {
  worker: Worker;
  jobId: string | null;
  closing: boolean;
}
const backendWorkers = new Map<Job["backend"], BackendWorker>();
let running = 0;
let admittedJobs = 0;
let admittedBytes = 0;

export interface UploadAdmission {
  reservedBytes: number;
  released: boolean;
}

/** Reserve capacity before Multer starts writing an upload to disk. */
export function admitUpload(reservedBytes: number): UploadAdmission | null {
  const bytes = Math.max(1, Math.min(MAX_UPLOAD_BYTES, reservedBytes));
  if (
    admittedJobs >= MAX_PENDING_JOBS ||
    admittedBytes + bytes > MAX_PENDING_UPLOAD_BYTES
  ) {
    return null;
  }
  admittedJobs++;
  admittedBytes += bytes;
  return { reservedBytes: bytes, released: false };
}

export function releaseUploadAdmission(admission: UploadAdmission): void {
  if (admission.released) return;
  admission.released = true;
  admittedJobs = Math.max(0, admittedJobs - 1);
  admittedBytes = Math.max(0, admittedBytes - admission.reservedBytes);
}

/** Reconcile the reservation with the actual file size after Multer finishes. */
export function resizeUploadAdmission(
  admission: UploadAdmission,
  actualBytes: number,
): boolean {
  if (admission.released) return false;
  const bytes = Math.max(1, Math.min(MAX_UPLOAD_BYTES, actualBytes));
  const delta = bytes - admission.reservedBytes;
  if (delta > 0 && admittedBytes + delta > MAX_PENDING_UPLOAD_BYTES) {
    return false;
  }
  admittedBytes += delta;
  admission.reservedBytes = bytes;
  return true;
}

function releaseJobAdmission(job: Job): void {
  releaseUploadAdmission(job.admission);
}

/**
 * Resolve the bundled worker entry. After esbuild bundling this module is part
 * of dist/index.mjs, so import.meta.url points at dist/; each backend is emitted
 * as its own entry under dist/transcribe/.
 */
function workerEntry(backend: Job["backend"]): string {
  const entry =
    backend === "parakeet" ? "parakeetWorker.mjs" : "worker.mjs";
  return fileURLToPath(new URL(`./transcribe/${entry}`, import.meta.url));
}

function getBackendWorker(backend: Job["backend"]): BackendWorker {
  const existing = backendWorkers.get(backend);
  if (existing && !existing.closing) return existing;

  const state: BackendWorker = {
    worker: new Worker(workerEntry(backend), {
      workerData: { persistent: true },
    }),
    jobId: null,
    closing: false,
  };
  backendWorkers.set(backend, state);

  state.worker.on("error", (err: Error) => {
    logger.error({ err, jobId: state.jobId }, "transcription worker crashed");
    state.closing = true;
    const job = state.jobId ? jobs.get(state.jobId) : undefined;
    if (job) {
      job.state = "error";
      job.error = err.message || "Transcription worker crashed.";
      job.message = "Error";
      job.finishedAt = Date.now();
      touch(job);
      finish(job);
    }
    void state.worker.terminate().catch(() => {});
  });

  state.worker.on("exit", () => {
    const job = state.jobId ? jobs.get(state.jobId) : undefined;
    if (job) {
      job.state = "error";
      job.error = "Transcription worker exited unexpectedly.";
      job.message = "Error";
      job.finishedAt = Date.now();
      touch(job);
      finish(job);
    }
    state.closing = true;
    if (backendWorkers.get(backend) === state) {
      backendWorkers.delete(backend);
    }
    pump();
  });

  return state;
}

function touch(job: Job): void {
  job.updatedAt = Date.now();
}

/** Create a job from an already-persisted upload and start or queue it. */
export async function createJob(params: {
  filePath: string;
  fileDir: string;
  modelId: string;
  backend: "whisper" | "parakeet";
  language: string;
  admission: UploadAdmission;
}): Promise<Job> {
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    state: "queued",
    message: "Queued…",
    progress: null,
    words: null,
    error: null,
    filePath: params.filePath,
    fileDir: params.fileDir,
    modelId: params.modelId,
    backend: params.backend,
    language: params.language,
    worker: null,
    admission: params.admission,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  waiting.push(job.id);
  pump();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Try to start queued jobs up to the concurrency cap. */
function pump(): void {
  let inspected = 0;
  while (
    running < MAX_CONCURRENT &&
    waiting.length > 0 &&
    inspected < waiting.length
  ) {
    const id = waiting.shift()!;
    const job = jobs.get(id);
    // Skip jobs cancelled while queued.
    if (!job || job.state === "error" || job.state === "done") {
      inspected = 0;
      continue;
    }
    const backendWorker = backendWorkers.get(job.backend);
    if (backendWorker?.jobId || backendWorker?.closing) {
      // Leave same-backend work queued while another backend can still use a
      // free slot. The idle worker calls pump again when it finishes.
      waiting.push(id);
      inspected++;
      continue;
    }
    startWorker(job);
    inspected = 0;
  }
}

function startWorker(job: Job): void {
  running++;
  const state = getBackendWorker(job.backend);
  state.jobId = job.id;
  state.worker.removeAllListeners("message");
  job.worker = state.worker;
  job.state = "downloading";
  touch(job);

  state.worker.on("message", (msg: WorkerOutMessage) => {
    switch (msg.type) {
      case "progress":
        // The download stage reports through the same channel; keep the client
        // state honest by moving to "transcribing" once real inference starts.
        if (msg.message === "Transcribing…") job.state = "transcribing";
        else if (job.state !== "transcribing") job.state = "downloading";
        job.message = msg.message ?? job.message;
        job.progress = msg.value ?? null;
        touch(job);
        break;
      case "partial":
        // Partial text is surfaced as the progress message so the client's
        // existing partial-text panel can show it without a new channel: any
        // "transcribing" message that isn't the literal stage label is treated
        // as partial text by the client.
        if (msg.text) job.message = msg.text;
        job.state = "transcribing";
        touch(job);
        break;
      case "complete":
        job.state = "done";
        job.words = msg.words ?? [];
        job.message = "Done";
        job.progress = 1;
        job.finishedAt = Date.now();
        touch(job);
        finish(job);
        break;
      case "error":
        job.state = "error";
        job.error = msg.message ?? "Transcription failed.";
        job.message = "Error";
        job.finishedAt = Date.now();
        touch(job);
        finish(job);
        break;
    }
  });

  state.worker.postMessage({
    filePath: job.filePath,
    modelId: job.modelId,
    backend: job.backend,
    language: job.language,
    cacheDir: modelCacheDir(),
  });
}

/** Finish a job and clean up uploaded media while keeping the worker alive. */
function finish(job: Job): void {
  const state = backendWorkers.get(job.backend);
  if (state?.jobId === job.id) {
    state.jobId = null;
    job.worker = null;
    running = Math.max(0, running - 1);
    if (!state.closing) pump();
    // Remove the uploaded file as soon as inference is over; the transcript is
    // in memory and the media is not needed again.
    void rm(job.fileDir, { recursive: true, force: true }).catch(() => {});
  }
  if (job.state === "done" || job.state === "error") {
    releaseJobAdmission(job);
  }
}

/** Cancel a job: stop its worker, mark it, and delete its media. */
export async function cancelJob(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;
  // Drop it from the queue if it never started.
  const qi = waiting.indexOf(id);
  if (qi >= 0) waiting.splice(qi, 1);

  if (job.state !== "done" && job.state !== "error") {
    job.state = "error";
    job.error = "Cancelled";
    job.message = "Cancelled";
    job.finishedAt = Date.now();
  }
  const activeWorker = backendWorkers.get(job.backend);
  const workerIsBusy = activeWorker?.jobId === job.id;
  // A persistent native worker cannot be terminated and immediately replaced
  // safely: the next thread may fail to self-register the ONNX addon. Keep its
  // slot occupied while the current run unwinds, but stop exposing this job.
  if (!workerIsBusy) {
    finish(job);
  }
  releaseJobAdmission(job);
  await rm(job.fileDir, { recursive: true, force: true }).catch(() => {});
  jobs.delete(id);
  return true;
}

/** Make a per-job temp dir for the upload under the OS temp root. */
export async function makeUploadDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "rescript-upload-"));
}

/** Periodically reap terminal or stale jobs. */
function reap(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const terminal = job.state === "done" || job.state === "error";
    if (terminal && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      void rm(job.fileDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(id);
      continue;
    }
    if (!terminal && now - job.updatedAt > STALE_MS) {
      void cancelJob(id).catch(() => {});
    }
  }
}

const reaper = setInterval(reap, 60 * 1000);
// Do not keep the process alive just for the reaper.
reaper.unref?.();
