/**
 * Server-side transcription hook.
 *
 * The mirror of {@link useTranscriber}: instead of running Whisper in a browser
 * Web Worker, it uploads the original media file to the API server, which runs
 * the same patched transformers Whisper on the CPU in a worker thread, and polls
 * the job until it produces a word list. Progress, partial text, and the final
 * words are piped into the same store slots the browser worker uses, so the
 * editor UI does not care which backend produced the transcript.
 *
 * This is the default for the Whisper Base and Small models. Parakeet stays on
 * the browser worker (see {@link useTranscriber}) because its runtime is
 * browser-only.
 *
 * Uploading the media (rather than decoded PCM) keeps the request small relative
 * to raw audio and lets the server decode with ffmpeg exactly as the model
 * expects.
 */
import { useCallback, useEffect, useRef } from "react";
import {
  getTranscriptionStatus,
  getUploadTranscriptionUrl,
  cancelTranscription as apiCancelTranscription,
} from "@workspace/api-client-react";
import { en } from "@/lib/i18n/messages/en";
import { isModelId } from "@/lib/models";
import { reportError } from "@/lib/sentry";
import { useEditorStore } from "@/lib/store";
import { trackEvent } from "@/lib/telemetry";
import type { Word } from "@/lib/types";

/** Poll interval while a job is running. */
const POLL_MS = 1500;

interface ActiveJob {
  jobId: string | null;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

let active: ActiveJob | null = null;

/** Stop the in-flight server job: cancel polling and tell the server to drop it. */
export function cancelServerTranscription() {
  const job = active;
  active = null;
  if (!job) return;
  job.cancelled = true;
  if (job.timer) clearTimeout(job.timer);
  if (job.jobId) {
    // Best-effort: the server also reaps abandoned jobs on a TTL.
    void apiCancelTranscription(job.jobId).catch(() => {});
  }
}

/** Map an API status message key back to the app's runtime message strings. */
function mapMessage(message: string): string {
  switch (message) {
    case "Loading cached speech model…":
      return en["progress.loadingSpeechCache"];
    case "Downloading speech model…":
      return en["progress.downloadingSpeech"];
    case "Transcribing…":
      return en["progress.transcribing"];
    case "Queued…":
      return en["progress.loadingSpeechModel"];
    default:
      return message;
  }
}

/**
 * Uploads the media file and returns a job id. The generated upload helper only
 * sends model/language, so the file is attached here as multipart.
 */
async function uploadMedia(
  file: File,
  model: string,
  language: string,
): Promise<string> {
  const form = new FormData();
  form.append("model", model);
  form.append("language", language);
  form.append("file", file, file.name);

  const res = await fetch(getUploadTranscriptionUrl(), {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // Non-JSON error body.
    }
    throw new Error(detail || `Upload failed (${res.status}).`);
  }
  const data = (await res.json()) as { jobId: string };
  return data.jobId;
}

/** Drives one server transcription job end-to-end, updating the store. */
export function useServerTranscriber() {
  useEffect(() => {
    return () => {
      cancelServerTranscription();
    };
  }, []);

  const transcribe = useCallback((file: File) => {
    const store = useEditorStore.getState();
    if (!isModelId(store.source)) {
      store.setError(en["error.selectModel"]);
      return;
    }
    const model = store.source;
    const language = store.transcriptLanguage;

    store.setStatus("transcribing");
    store.setProgress({
      message: en["progress.loadingSpeechModel"],
      value: null,
    });

    // Start fresh; a prior cancel must not leave a dangling poll loop.
    cancelServerTranscription();
    const job: ActiveJob = { jobId: null, cancelled: false, timer: null };
    active = job;

    const fail = (message: string, report = true) => {
      if (job.cancelled) return;
      const s = useEditorStore.getState();
      if (s.skipTranscription) return;
      s.setError(message);
      if (report) reportError(new Error(message), "server-transcription");
    };

    const poll = async () => {
      if (job.cancelled || !job.jobId) return;
      let status;
      try {
        status = await getTranscriptionStatus(job.jobId);
      } catch (err) {
        // A transient poll failure should retry rather than abort the job.
        if (!job.cancelled) {
          job.timer = setTimeout(() => void poll(), POLL_MS);
        }
        void err;
        return;
      }
      if (job.cancelled) return;
      const s = useEditorStore.getState();
      // An imported transcript sets skipTranscription; ignore late results.
      if (s.skipTranscription) {
        cancelServerTranscription();
        return;
      }

      switch (status.state) {
        case "done": {
          const words: Word[] = (status.words ?? []).map((w, i) => ({
            id: i,
            text: w.text,
            start: w.start,
            end: w.end,
            speaker: w.speaker,
            deleted: w.deleted,
          }));
          s.setWords(words);
          s.setStatus("ready");
          s.setPartialText("");
          active = null;
          trackEvent("transcription_completed", { model, language });
          break;
        }
        case "error": {
          const raw = status.error ?? en["error.workerCrashed"];
          // A dropped download is the user's network; the server surfaces it as
          // a network cause via the message, but we can't act on it, so skip the
          // crash report the same way the browser path does.
          const isNetwork = /network|fetch failed|connection/i.test(raw);
          active = null;
          fail(
            isNetwork ? en["error.modelDownload"] : raw,
            !isNetwork,
          );
          break;
        }
        default: {
          if (status.state === "transcribing" && status.message !== "Transcribing…") {
            // The server surfaces streaming partial text as the job message
            // once inference starts (any message other than the stage label).
            s.setPartialText(status.message);
            s.setProgress({
              message: en["progress.transcribing"],
              value: status.progress ?? null,
            });
          } else {
            s.setProgress({
              message: mapMessage(status.message),
              value: status.progress ?? null,
            });
          }
          job.timer = setTimeout(() => void poll(), POLL_MS);
        }
      }
    };

    void (async () => {
      try {
        const jobId = await uploadMedia(file, model, language);
        if (job.cancelled) {
          void apiCancelTranscription(jobId).catch(() => {});
          return;
        }
        job.jobId = jobId;
        void poll();
      } catch (err) {
        active = null;
        const message =
          err instanceof Error ? err.message : en["error.processFile"];
        fail(message);
      }
    })();
  }, []);

  return { transcribe, cancel: cancelServerTranscription };
}
