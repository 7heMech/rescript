"use client";

import { useCallback, useEffect, useRef } from "react";
import { useEditorStore } from "@/lib/store";
import type { WorkerResponse } from "@/lib/types";

/** Owns the transcription web worker and pipes its messages into the store. */
export function useTranscriber() {
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const transcribe = useCallback((audio: Float32Array, duration: number) => {
    const store = useEditorStore.getState();
    store.setStatus("transcribing");
    store.setProgress({ message: "Loading speech model…", value: null });

    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL("../workers/transcription.worker.ts", import.meta.url),
        { type: "module" }
      );
      workerRef.current.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const s = useEditorStore.getState();
        const msg = event.data;
        switch (msg.type) {
          case "progress":
            s.setProgress({ message: msg.message, value: msg.value });
            break;
          case "partial":
            s.setPartialText(msg.text);
            break;
          case "complete":
            s.setWords(msg.words);
            s.setStatus("ready");
            s.setPartialText("");
            break;
          case "error":
            s.setError(msg.message);
            break;
        }
      };
      workerRef.current.onerror = (err) => {
        useEditorStore.getState().setError(err.message || "Transcription worker crashed.");
      };
    }

    // Transfer a copy so the original stays available for the waveform.
    const copy = audio.slice();
    workerRef.current.postMessage(
      { audio: copy, duration, model: store.model },
      [copy.buffer]
    );
  }, []);

  return { transcribe };
}
