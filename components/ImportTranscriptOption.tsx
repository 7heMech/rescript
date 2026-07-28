"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import {
  isTranscriptFile,
  parseTranscriptFile,
  TRANSCRIPT_ACCEPT,
} from "@/lib/parseTranscript";
import { isWhisperModel } from "@/lib/models";
import { useEditorStore } from "@/lib/store";
import {
  ModelOption,
  useModelOption,
  useOptionTrigger,
  type ModelOptionContextValue,
} from "./ModelSelector";

/**
 * ModelSelector option that opens a caption file picker and surfaces parse
 * status / errors on the row (and in the closed trigger).
 *
 * Do not set model to "import" until a file is successfully parsed (or we
 * have a concrete error to show). Native file-picker cancel often does not
 * fire onChange — previously `select()` ran first, then the menu unmounted
 * and dropped the custom trigger, leaving the closed button stuck on the
 * literal label "import" with the default wave icon. That same stuck
 * `model === "import"` (with no pending file) is what made media drops
 * complain about choosing a transcript while the UI looked like Whisper.
 */
export default function ImportTranscriptOption() {
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  const setPendingTranscript = useEditorStore((s) => s.setPendingTranscript);
  const setModel = useEditorStore((s) => s.setModel);
  const selected = useEditorStore((s) => s.model === "import");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<Pick<
    ModelOptionContextValue,
    "keepMenuOpen" | "select"
  > | null>(null);
  const previousModelRef = useRef<"base" | "small">("base");
  const pickGenRef = useRef(0);

  // If the user switches to Whisper while a picker/parse is in flight, invalidate
  // so a late onChange/parse cannot flip model back to import.
  useEffect(() => {
    return useEditorStore.subscribe((state, prev) => {
      if (!isWhisperModel(state.model) || state.model === prev.model) return;
      pickGenRef.current += 1;
      queueMicrotask(() => {
        setPicking(false);
        setReading(false);
        setError(null);
      });
    });
  }, []);

  // If the OS file dialog is cancelled, onChange often never fires. When focus
  // returns without a successful pick, clear the transient picking state and
  // ensure we are not left on import without a transcript.
  useEffect(() => {
    if (!picking) return;
    const gen = pickGenRef.current;
    const onFocus = () => {
      window.setTimeout(() => {
        if (pickGenRef.current !== gen) return;
        setPicking(false);
        const state = useEditorStore.getState();
        if (state.model === "import" && !state.pendingTranscript) {
          setModel(previousModelRef.current);
        }
      }, 400);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [picking, setModel]);

  const triggerLabel = reading
    ? "Import…"
    : error
      ? "Import failed"
      : pendingTranscript
        ? pendingTranscript.name
        : "Import transcript";

  // Keep the custom trigger registered whenever import owns (or is about to
  // own) the closed button — otherwise ModelSelector falls back to the raw id
  // "import" + AudioLines.
  const triggerEnabled =
    selected || picking || reading || Boolean(error) || Boolean(pendingTranscript);

  return (
    <ModelOption
      id="import"
      label="Import transcript"
      meta="SRT / VTT / JSON"
      icon={FileText}
      autoTrigger={false}
      onSelect={(ctx) => {
        menuRef.current = ctx;
        const current = useEditorStore.getState().model;
        if (isWhisperModel(current)) {
          previousModelRef.current = current;
        }
        // Do not set model to "import" until parse succeeds (or errors).
        pickGenRef.current += 1;
        setPicking(true);
        setError(null);
        ctx.keepMenuOpen();
        requestAnimationFrame(() => fileRef.current?.click());
      }}
    >
      <ImportTrigger
        label={triggerLabel}
        busy={reading}
        error={Boolean(error)}
        enabled={triggerEnabled}
      />
      <input
        ref={fileRef}
        type="file"
        accept={TRANSCRIPT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          e.target.value = "";
          void (async () => {
            const file = files?.[0];
            const menu = menuRef.current;
            const gen = ++pickGenRef.current; // invalidate focus-cancel timer
            if (!file) {
              setPicking(false);
              setError(null);
              if (!useEditorStore.getState().pendingTranscript) {
                setModel(previousModelRef.current);
              }
              return;
            }
            if (!isTranscriptFile(file)) {
              setPicking(false);
              setError("Choose an SRT, VTT, or JSON file.");
              setPendingTranscript(null);
              setModel("import");
              menu?.keepMenuOpen();
              return;
            }
            setReading(true);
            setError(null);
            menu?.keepMenuOpen();
            try {
              const words = await parseTranscriptFile(file);
              if (pickGenRef.current !== gen) return;
              setPendingTranscript({ name: file.name, words });
              setModel("import");
              setPicking(false);
              menu?.keepMenuOpen();
            } catch (err) {
              if (pickGenRef.current !== gen) return;
              console.error(err);
              setPendingTranscript(null);
              setError(
                err instanceof Error
                  ? err.message
                  : "Could not read that transcript."
              );
              setModel("import");
              setPicking(false);
              menu?.keepMenuOpen();
            } finally {
              if (pickGenRef.current === gen) setReading(false);
            }
          })();
        }}
      />
      <ImportStatus reading={reading} error={error} picking={picking} />
    </ModelOption>
  );
}

function ImportTrigger({
  label,
  busy,
  error,
  enabled,
}: {
  label: string;
  busy: boolean;
  error: boolean;
  enabled: boolean;
}) {
  useOptionTrigger(
    "import",
    {
      label,
      icon: FileText,
      iconClassName: error ? "text-red-500" : "text-zinc-500",
      busy,
    },
    enabled
  );
  return null;
}

function ImportStatus({
  reading,
  error,
  picking,
}: {
  reading: boolean;
  error: string | null;
  picking: boolean;
}) {
  const { selected } = useModelOption();
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  if (!picking && !selected && !reading && !error) return null;
  if (!reading && !pendingTranscript && !error && !picking) return null;
  return (
    <span
      className={`pl-[1.625rem] text-[11px] leading-snug ${
        error ? "text-red-500" : "text-zinc-500"
      }`}
    >
      {reading ? (
        <span className="inline-flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" />
          Reading file…
        </span>
      ) : error ? (
        error
      ) : pendingTranscript ? (
        `${pendingTranscript.name} · ${pendingTranscript.words.length} words`
      ) : picking ? (
        "Choose an SRT, VTT, or JSON file…"
      ) : null}
    </span>
  );
}
