"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AudioLines, ChevronDown } from "lucide-react";
import { MODEL_ORDER, MODELS, type ModelChoice } from "@/lib/models";
import { useEditorStore } from "@/lib/store";

/**
 * Compact model picker for the upload screen. Opens upward like a popover
 * menu: group label + icon/name rows, with the trigger showing the current
 * choice.
 */
export default function ModelSelector() {
  const model = useEditorStore((s) => s.model);
  const setModel = useEditorStore((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = MODELS[model];

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

  const select = (choice: ModelChoice) => {
    setModel(choice);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative flex justify-center">
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Speech model"
          className="absolute bottom-[calc(100%+0.5rem)] z-20 w-[min(100%,18rem)] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-zinc-900/5"
        >
          <p className="px-3 pb-1 pt-2.5 text-[11px] font-medium tracking-wide text-zinc-400">
            Speech model
          </p>
          <div className="p-1 pb-1.5">
            {MODEL_ORDER.map((id) => {
              const info = MODELS[id];
              const selected = id === model;
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => select(id)}
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
          </div>
        </div>
      )}

      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-800 shadow-sm shadow-zinc-900/5 transition hover:border-zinc-300 hover:bg-zinc-50"
      >
        <AudioLines size={14} className="text-zinc-500" />
        <span>{current.label}</span>
        <ChevronDown
          size={14}
          className={`text-zinc-400 transition ${open ? "rotate-180" : ""}`}
        />
      </button>
    </div>
  );
}
