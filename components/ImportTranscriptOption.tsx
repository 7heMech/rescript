"use client";

import { useRef, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { loadModelPreference } from "@/lib/models";
import {
  isTranscriptFile,
  parseTranscriptFile,
  TRANSCRIPT_ACCEPT,
} from "@/lib/parseTranscript";
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
 */
export default function ImportTranscriptOption() {
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  const setPendingTranscript = useEditorStore((s) => s.setPendingTranscript);
  const setModel = useEditorStore((s) => s.setModel);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<Pick<
    ModelOptionContextValue,
    "keepMenuOpen" | "select"
  > | null>(null);

  const triggerLabel = reading
    ? "Import…"
    : error
      ? "Import failed"
      : pendingTranscript
        ? pendingTranscript.name
        : "Import transcript";

  return (
    <ModelOption
      id="import"
      label="Import transcript"
      meta="SRT / VTT / JSON"
      icon={FileText}
      autoTrigger={false}
      onSelect={(ctx) => {
        menuRef.current = ctx;
        ctx.select();
        setError(null);
        ctx.keepMenuOpen();
        requestAnimationFrame(() => fileRef.current?.click());
      }}
    >
      <ImportTrigger
        label={triggerLabel}
        busy={reading}
        error={Boolean(error)}
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
            if (!file) {
              if (!pendingTranscript) {
                setError(null);
                setModel(loadModelPreference());
              }
              return;
            }
            if (!isTranscriptFile(file)) {
              setError("Choose an SRT, VTT, or JSON file.");
              setPendingTranscript(null);
              menu?.keepMenuOpen();
              return;
            }
            setReading(true);
            setError(null);
            menu?.keepMenuOpen();
            try {
              const words = await parseTranscriptFile(file);
              setPendingTranscript({ name: file.name, words });
              menu?.select();
              menu?.keepMenuOpen();
            } catch (err) {
              console.error(err);
              setPendingTranscript(null);
              setError(
                err instanceof Error
                  ? err.message
                  : "Could not read that transcript."
              );
              menu?.select();
              menu?.keepMenuOpen();
            } finally {
              setReading(false);
            }
          })();
        }}
      />
      <ImportStatus reading={reading} error={error} />
    </ModelOption>
  );
}

function ImportTrigger({
  label,
  busy,
  error,
}: {
  label: string;
  busy: boolean;
  error: boolean;
}) {
  useOptionTrigger("import", {
    label,
    icon: FileText,
    iconClassName: error ? "text-red-500" : "text-zinc-500",
    busy,
  });
  return null;
}

function ImportStatus({
  reading,
  error,
}: {
  reading: boolean;
  error: string | null;
}) {
  const { selected } = useModelOption();
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  if (!selected || (!reading && !pendingTranscript && !error)) return null;
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
      ) : null}
    </span>
  );
}
