/**
 * Server-side transcription routes.
 *
 * POST /transcribe/upload          multipart media -> queued job -> { jobId }
 * GET  /transcribe/:jobId/status   poll state, progress, and final words
 * DELETE /transcribe/:jobId        cancel + delete uploaded media
 *
 * The media file is streamed to a per-job temp dir by multer (disk storage), so
 * large uploads never sit fully in memory. The worker reads it from disk and it
 * is deleted the moment inference ends.
 */
import { Router, type IRouter, type Request } from "express";
import { rm } from "node:fs/promises";
import multer from "multer";
import path from "node:path";
import {
  GetTranscriptionStatusResponse,
  UploadTranscriptionResponse,
} from "@workspace/api-zod";
import {
  cancelJob,
  createJob,
  admitUpload,
  getJob,
  MAX_UPLOAD_BYTES,
  makeUploadDir,
  releaseUploadAdmission,
  resizeUploadAdmission,
  type JobState,
  type UploadAdmission,
} from "../transcribe/jobs";

const router: IRouter = Router();

/**
 * Speech models the server path supports, keyed by the client's model id.
 *
 * `backend` selects the worker's inference path: "whisper" runs the
 * transformers.js pipeline, "parakeet" runs parakeet.js on onnxruntime-node.
 */
const SERVER_MODELS: Record<
  string,
  { backend: "whisper" | "parakeet"; modelId: string }
> = {
  base: {
    backend: "whisper",
    modelId: "onnx-community/whisper-base_timestamped",
  },
  small: {
    backend: "whisper",
    modelId: "onnx-community/whisper-small_timestamped",
  },
  parakeet: { backend: "parakeet", modelId: "parakeet-tdt-0.6b-v3" },
};

/**
 * Transcript language hints the server accepts.
 *
 * Whisper decodes the requested language directly. Parakeet v3 auto-detects and
 * ignores the hint, but it is still validated here so an unsupported value fails
 * the same way on both backends rather than silently changing meaning.
 */
const SUPPORTED_LANGUAGES = new Set(["en", "es", "fr", "de", "zh", "bg"]);

/** Multipart framing is small relative to the media ceiling. */
const MAX_MULTIPART_OVERHEAD = 1024 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_UPLOADS_PER_WINDOW = Number(
  process.env["TRANSCRIBE_UPLOADS_PER_MINUTE"] ?? 6,
);
const uploadAttempts = new Map<string, number[]>();

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function allowUploadAttempt(req: Request): boolean {
  const now = Date.now();
  const key = clientKey(req);
  const recent = (uploadAttempts.get(key) ?? []).filter(
    (timestamp) => now - timestamp < RATE_WINDOW_MS,
  );
  if (recent.length >= MAX_UPLOADS_PER_WINDOW) {
    uploadAttempts.set(key, recent);
    return false;
  }
  recent.push(now);
  uploadAttempts.set(key, recent);
  return true;
}

async function cleanupUploadDir(
  uploadDir: string | undefined,
  filePath: string | undefined,
): Promise<void> {
  const dir = uploadDir ?? (filePath ? path.dirname(filePath) : undefined);
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function estimatedUploadBytes(req: Request): number {
  const raw = req.headers["content-length"];
  const contentLength = typeof raw === "string" ? Number(raw) : Number(raw?.[0]);
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return MAX_UPLOAD_BYTES;
  }
  return Math.min(MAX_UPLOAD_BYTES, contentLength);
}

// Disk storage into a fresh per-request temp dir; the dir is tracked on the
// request so a validation failure can still clean it up.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      makeUploadDir()
        .then((dir) => {
          (req as Request & { _uploadDir?: string })._uploadDir = dir;
          cb(null, dir);
        })
        .catch((err) => cb(err as Error, ""));
    },
    filename: (_req, file, cb) => {
      // Keep the extension so ffmpeg can sniff the container.
      const ext = path.extname(file.originalname).slice(0, 12);
      cb(null, `media${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

router.post("/transcribe/upload", (req, res) => {
  const contentLength = Number(req.headers["content-length"]);
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_UPLOAD_BYTES + MAX_MULTIPART_OVERHEAD
  ) {
    res.status(413).json({ error: "Upload failed or file too large." });
    return;
  }
  if (!allowUploadAttempt(req)) {
    res.status(429).json({ error: "Too many transcription uploads. Try again later." });
    return;
  }
  const admission = admitUpload(estimatedUploadBytes(req));
  if (!admission) {
    res.status(429).json({ error: "Transcription capacity is temporarily full." });
    return;
  }

  upload.single("file")(req, res, (err: unknown) => {
    void (async () => {
      const uploadDir = (req as Request & { _uploadDir?: string })._uploadDir;
      let handedOff = false;
      let queuedJobId: string | undefined;

      try {
        if (err) {
          req.log.warn({ err }, "upload failed");
          res.status(400).json({ error: "Upload failed or file too large." });
          return;
        }

        const file = req.file;
        const model = typeof req.body?.model === "string" ? req.body.model : "";
        const language =
          typeof req.body?.language === "string" ? req.body.language : "";

        const entry = SERVER_MODELS[model];
        if (!file || !entry || !SUPPORTED_LANGUAGES.has(language)) {
          res
            .status(400)
            .json({ error: "Missing file, or unsupported model/language." });
          return;
        }
        if (!resizeUploadAdmission(admission, file.size)) {
          res
            .status(429)
            .json({ error: "Transcription capacity is temporarily full." });
          return;
        }

        const job = await createJob({
          filePath: file.path,
          fileDir: uploadDir ?? path.dirname(file.path),
          modelId: entry.modelId,
          backend: entry.backend,
          language,
          admission,
        });
        queuedJobId = job.id;

        const data = UploadTranscriptionResponse.parse({ jobId: job.id });
        handedOff = true;
        res.status(202).json(data);
      } catch (routeError) {
        req.log.error({ err: routeError }, "transcription upload route failed");
        if (queuedJobId) {
          await cancelJob(queuedJobId).catch(() => {});
        }
        if (!res.headersSent) {
          res.status(500).json({ error: "Could not queue transcription." });
        }
      } finally {
        if (!handedOff) {
          releaseUploadAdmission(admission);
          await cleanupUploadDir(uploadDir, req.file?.path);
        }
      }
    })();
  });
});

/** Map an internal job into the OpenAPI status shape. */
function toStatus(job: {
  id: string;
  state: JobState;
  message: string;
  progress: number | null;
  words: unknown;
  error: string | null;
}) {
  return {
    jobId: job.id,
    state: job.state,
    message: job.message,
    progress: job.progress,
    words: job.state === "done" ? job.words : null,
    error: job.error,
  };
}

router.get("/transcribe/:jobId/status", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }
  const data = GetTranscriptionStatusResponse.parse(toStatus(job));
  res.json(data);
});

router.delete("/transcribe/:jobId", (req, res) => {
  void (async () => {
    const ok = await cancelJob(req.params.jobId);
    if (!ok) {
      res.status(404).json({ error: "Job not found." });
      return;
    }
    res.sendStatus(204);
  })();
});

export default router;
