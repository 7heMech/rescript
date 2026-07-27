"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AudioLines, ChevronDown, FileText, Loader2 } from "lucide-react";
import {
  MODELS,
  WHISPER_ORDER,
  loadModelPreference,
  type WhisperModel,
} from "@/lib/models";
import {
  isTranscriptFile,
  parseTranscriptFile,
  TRANSCRIPT_ACCEPT,
} from "@/lib/parseTranscript";
import { hydrateModelPreference, useEditorStore } from "@/lib/store";

/**
 * Compact source picker for the upload screen: Whisper Base / Small, or
 * import an SRT/VTT/JSON transcript. Import status and errors stay inside
 * the Import option row.
 */
export default function ModelSelector() {
  const model = useEditorStore((s) => s.model);
  const setModel = useEditorStore((s) => s.setModel);
  const pendingTranscript = useEditorStore((s) => s.pendingTranscript);
  const setPendingTranscript = useEditorStore((s) => s.setPendingTranscript);
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    hydrateModelPreference();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerLabel = (): string => {
    if (model === "import") {
      if (reading) return "Import…";
      if (importError) return "Import failed";
      if (pendingTranscript) return pendingTranscript.name;
      return "Import transcript";
    }
    return MODELS[model].label;
  };

  const selectWhisper = (choice: WhisperModel) => {
    setImportError(null);
    setModel(choice);
    setOpen(false);
  };

  const selectImport = () => {
    setModel("import");
    setImportError(null);
    // Keep the menu open so status/errors show on the Import row.
    setOpen(true);
    // Defer so the menu paints before the native picker steals focus.
    requestAnimationFrame(() => fileRef.current?.click());
  };

  const onTranscriptPicked = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) {
      // Cancelled the picker with nothing loaded — return to last Whisper model.
      if (!pendingTranscript) {
        setImportError(null);
        setModel(loadModelPreference());
      }
      return;
    }
    if (!isTranscriptFile(file)) {
      setImportError("Choose an SRT, VTT, or JSON file.");
      setPendingTranscript(null);
      return;
    }
    setReading(true);
    setImportError(null);
    try {
      const words = await parseTranscriptFile(file);
      setPendingTranscript({ name: file.name, words });
      setModel("import");
    } catch (err) {
      console.error(err);
      setPendingTranscript(null);
      setImportError(
        err instanceof Error ? err.message : "Could not read that transcript."
      );
      setModel("import");
    } finally {
      setReading(false);
    }
  };

  const TriggerIcon = model === "import" ? FileText : AudioLines;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-[14rem] items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-800 shadow-sm shadow-zinc-900/5 transition hover:border-zinc-300 hover:bg-zinc-50"
      >
        {reading ? (
          <Loader2 size={14} className="shrink-0 animate-spin text-zinc-500" />
        ) : (
          <TriggerIcon
            size={14}
            className={`shrink-0 ${importError && model === "import" ? "text-red-500" : "text-zinc-500"}`}
          />
        )}
        <span className="truncate">{triggerLabel()}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-zinc-400 transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      <input
        ref={fileRef}
        type="file"
        accept={TRANSCRIPT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          e.target.value = "";
          void onTranscriptPicked(files);
        }}
      />

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Transcript source"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-20 w-[18rem] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-zinc-900/5"
        >
          <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium tracking-wide text-zinc-400">
            Transcript source
          </p>
          <div className="p-1 pb-1.5">
            {WHISPER_ORDER.map((id) => {
              const info = MODELS[id];
              const selected = id === model;
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => selectWhisper(id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                    selected
                      ? "bg-zinc-100 text-zinc-900"
                      : "text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  <AudioLines
                    size={15}
                    className={selected ? "text-zinc-700" : "text-zinc-400"}
                  />
                  <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight">
                    {info.label}
                  </span>
                  <span className="shrink-0 text-[11px] text-zinc-400">{info.size}</span>
                </button>
              );
            })}

            <div className="my-1 border-t border-zinc-100" />

            <button
              type="button"
              role="option"
              aria-selected={model === "import"}
              onClick={selectImport}
              className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition ${
                model === "import"
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              <span className="flex w-full items-center gap-2.5">
                {reading ? (
                  <Loader2 size={15} className="shrink-0 animate-spin text-zinc-500" />
                ) : (
                  <FileText
                    size={15}
                    className={
                      model === "import"
                        ? importError
                          ? "text-red-500"
                          : "text-zinc-700"
                        : "text-zinc-400"
                    }
                  />
                )}
                <span className="min-w-0 flex-1 text-[13px] font-medium leading-tight">
                  Import transcript
                </span>
                <span className="shrink-0 text-[11px] text-zinc-400">
                  SRT / VTT / JSON
                </span>
              </span>
              {model === "import" && (reading || pendingTranscript || importError) && (
                <span
                  className={`pl-[1.625rem] text-[11px] leading-snug ${
                    importError ? "text-red-500" : "text-zinc-500"
                  }`}
                >
                  {reading
                    ? "Reading file…"
                    : importError
                      ? importError
                      : pendingTranscript
                        ? `${pendingTranscript.name} · ${pendingTranscript.words.length} words`
                        : null}
                </span>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
