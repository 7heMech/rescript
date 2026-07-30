"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bug, CircleAlert, ExternalLink, Moon, Settings, Sun } from "lucide-react";
import {
  DiscordIcon,
  DISCORD_INVITE_URL,
  GitHubIcon,
  GITHUB_REPO_URL,
  XIcon,
  X_PROFILE_URL,
} from "./SocialLinks";
import { useAppearance } from "@/hooks/useAppearance";
import PopupDismissBackdrop from "./PopupDismissBackdrop";
import type { Appearance } from "@/lib/theme";

const MENU_LINKS = [
  { label: "Support / feedback", href: DISCORD_INVITE_URL, Icon: DiscordIcon },
  {
    label: "Report an issue",
    href: `${GITHUB_REPO_URL}/issues`,
    Icon: Bug,
  },
  { label: "Homepage", href: GITHUB_REPO_URL, Icon: GitHubIcon },
  { label: "Follow on X", href: X_PROFILE_URL, Icon: XIcon },
] as const;

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
    <>
      {open && (
        <PopupDismissBackdrop onDismiss={() => setOpen(false)} zClassName="z-20" />
      )}
      <div ref={rootRef} className="relative z-30 shrink-0">
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
          className={`absolute right-0 top-[calc(100%+0.5rem)] z-30 w-[15rem] overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg shadow-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/40 ${
            open ? "" : "pointer-events-none"
          }`}
          style={open ? undefined : { display: "none" }}
        >
          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              Appearance
            </p>
            <div
              className="grid grid-cols-2 gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
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

          <section className="py-1.5">
            {MENU_LINKS.map(({ label, href, Icon }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-zinc-700 transition hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/80"
              >
                <span className="shrink-0 text-zinc-400 dark:text-zinc-500">
                  <Icon size={14} />
                </span>
                <span className="flex-1">{label}</span>
                <ExternalLink
                  size={12}
                  className="shrink-0 text-zinc-300 dark:text-zinc-600"
                />
              </a>
            ))}
          </section>
        </div>
      </div>
    </>
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
      className={`flex cursor-pointer items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium transition ${
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
