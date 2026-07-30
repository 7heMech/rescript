"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Moon, Settings, Sun } from "lucide-react";
import ModelSelector, {
  ModelOption,
  ModelOptionSeparator,
} from "./ModelSelector";
import ImportTranscriptOption from "./ImportTranscriptOption";
import SocialLinks from "./SocialLinks";
import { useAppearance } from "@/hooks/useAppearance";
import type { Appearance } from "@/lib/theme";

/**
 * Top-bar settings popover. Houses appearance, transcript source, and social
 * links for now — structure is section-based so more prefs can land here later.
 */
export default function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { appearance, setAppearance } = useAppearance();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title="Settings"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <Settings size={16} />
      </button>

      <div
        id={panelId}
        role="dialog"
        aria-label="Settings"
        hidden={!open}
        className={`absolute right-0 top-[calc(100%+0.5rem)] z-30 w-[18rem] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/40 ${
          open ? "" : "pointer-events-none"
        }`}
        style={open ? undefined : { display: "none" }}
      >
        <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
          <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
            Appearance
          </p>
          <div
            className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800"
            role="radiogroup"
            aria-label="Appearance"
          >
            <AppearanceOption
              value="light"
              label="Light"
              icon={Sun}
              selected={appearance === "light"}
              onSelect={setAppearance}
            />
            <AppearanceOption
              value="dark"
              label="Dark"
              icon={Moon}
              selected={appearance === "dark"}
              onSelect={setAppearance}
            />
          </div>
        </section>

        <section className="border-b border-zinc-100 dark:border-zinc-800">
          <ModelSelector
            embedded
            groupLabel="Transcript source"
            onClose={() => setOpen(false)}
            onKeepOpen={() => setOpen(true)}
          >
            <ModelOption id="base" />
            <ModelOption id="small" />
            <ModelOptionSeparator />
            <ImportTranscriptOption />
          </ModelSelector>
        </section>

        <section className="px-3 py-2.5">
          <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
            Links
          </p>
          <SocialLinks variant="text" />
        </section>
      </div>
    </div>
  );
}

function AppearanceOption({
  value,
  label,
  icon: Icon,
  selected,
  onSelect,
}: {
  value: Appearance;
  label: string;
  icon: typeof Sun;
  selected: boolean;
  onSelect: (value: Appearance) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(value)}
      className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition ${
        selected
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
