"use client";

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import {
  AudioLines,
  Clapperboard,
  Film,
  Loader2,
  Lock,
  Music,
  Scissors,
  ShieldAlert,
  Type,
} from "lucide-react";
import logo from "@/assets/logo.png";
import { useCrossOriginIsolated } from "@/hooks/useCrossOriginIsolated";
import { detectMediaKind, MEDIA_ACCEPT } from "@/lib/media";

// The three media cards that stand in for the upload icon. Each carries its
// resting transform plus the fanned-out one, applied either on hover (via the
// dropzone's `group`) or while a file is being dragged over.
const CARDS = [
  {
    icon: Film,
    size: "h-[4.25rem] w-[3.25rem]",
    iconSize: 18,
    bars: ["w-7", "w-4"],
    fan: "-rotate-[18deg] -translate-x-10 -translate-y-1.5",
    rest: "-rotate-[11deg] -translate-x-5 group-hover:-rotate-[18deg] group-hover:-translate-x-10 group-hover:-translate-y-1.5",
  },
  {
    icon: AudioLines,
    size: "h-20 w-16",
    iconSize: 22,
    bars: ["w-9", "w-5"],
    fan: "z-10 -translate-y-2.5",
    rest: "z-10 group-hover:-translate-y-2.5",
  },
  {
    icon: Music,
    size: "h-[4.25rem] w-[3.25rem]",
    iconSize: 18,
    bars: ["w-7", "w-4"],
    fan: "rotate-[18deg] translate-x-10 -translate-y-1.5",
    rest: "rotate-[11deg] translate-x-5 group-hover:rotate-[18deg] group-hover:translate-x-10 group-hover:-translate-y-1.5",
  },
] as const;

function MediaCards({ dragging }: { dragging: boolean }) {
  return (
    <div className="pointer-events-none relative mb-5 flex h-24 w-full items-center justify-center">
      {CARDS.map(({ icon: Icon, size, iconSize, bars, rest, fan }, i) => (
        <div
          key={i}
          className={`absolute flex flex-col items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white transition-transform duration-300 ease-out ${size} ${
            dragging ? fan : rest
          }`}
        >
          <Icon size={iconSize} className="text-neutral-400" />
          <div className="flex flex-col items-center gap-1">
            {bars.map((w) => (
              <span key={w} className={`block h-[3px] rounded-full bg-zinc-200 ${w}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function UploadScreen({ onFile }: { onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // The pipeline needs SharedArrayBuffer, which on static hosts only appears
  // after the COI service worker reloads the page. Accepting a file before then
  // would fail immediately and lose the file to that reload.
  const isolation = useCrossOriginIsolated();
  const ready = isolation === "ready";

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!ready) return;
      const file = files?.[0];
      if (!file) return;
      if (!detectMediaKind(file)) {
        alert("Please choose a video or audio file.");
        return;
      }
      onFile(file);
    },
    [onFile, ready]
  );

  return (
    <div className="flex flex-1 items-center justify-center bg-gradient-to-b from-zinc-50 to-neutral-50/50 p-6">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex justify-center">
          <Image
            src={logo}
            alt="Rescript"
            width={24}
            height={24}
            priority
            className="rounded-sm border border-zinc-200"
          />
          <p className="text-[15px] font-medium text-zinc-800 ml-2">Rescript</p>
        </div>
        <div
          role="button"
          aria-disabled={!ready}
          tabIndex={ready ? 0 : -1}
          onClick={() => ready && inputRef.current?.click()}
          onKeyDown={(e) => ready && e.key === "Enter" && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            if (ready) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`group flex flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white/80 px-8 py-14 text-center transition ${
            !ready
              ? "cursor-default border-zinc-200"
              : dragging
                ? "cursor-pointer border-neutral-500 bg-neutral-50/80"
                : "cursor-pointer border-zinc-300 hover:border-neutral-400 hover:bg-white"
          }`}
        >
          {ready ? (
            <MediaCards dragging={dragging} />
          ) : (
            <div
              className={`mb-3 flex h-12 w-12 items-center justify-center rounded-full ${
                isolation === "unavailable"
                  ? "bg-amber-50 text-amber-600"
                  : "bg-neutral-100 text-neutral-600"
              }`}
            >
              {isolation === "unavailable" ? (
                <ShieldAlert size={20} />
              ) : (
                <Loader2 size={20} className="animate-spin" />
              )}
            </div>
          )}
          {isolation === "unavailable" ? (
            <>
              <p className="text-[15px] font-medium text-zinc-800">
                This browser can&apos;t run the editor
              </p>
              <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-zinc-400">
                Editing needs SharedArrayBuffer, which requires a cross-origin-isolated page.
                Try a recent Chrome, Edge or Firefox over HTTPS.
              </p>
            </>
          ) : ready ? (
            <>
              <p className="text-[15px] font-medium text-zinc-800">
                Drop a video or audio file here, or{" "}
                <span className="text-neutral-600">browse</span>
              </p>
              <p className="mt-1 text-[13px] text-zinc-400">
                MP4, WebM, MOV, MP3, WAV, M4A, …
              </p>
            </>
          ) : (
            <>
              <p className="text-[15px] font-medium text-zinc-800">Getting things ready</p>
              <p className="mt-1 text-[13px] text-zinc-400">
                Setting up the media engine, this only happens once.
              </p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={MEDIA_ACCEPT}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { icon: Type, title: "Transcribe", text: "Per-word timing and speaker labels." },
            { icon: Scissors, title: "Edit", text: "Select words and hit delete to edit." },
            { icon: Clapperboard, title: "Export", text: "Render the final cut to MP4 or M4A." },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-xl border border-zinc-200 bg-white/70 p-4">
              <Icon size={16} className="mb-2 text-neutral-500" />
              <p className="text-[13px] font-semibold text-zinc-800">{title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{text}</p>
            </div>
          ))}
        </div>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-zinc-400">
          <Lock size={12} />
          No uploads, no accounts — your media never leaves this device.
        </p>
      </div>
    </div>
  );
}
