"use client";

import { useCallback, useRef, useState } from "react";
import { Clapperboard, Lock, Scissors, Type, Upload } from "lucide-react";

export default function UploadScreen({ onFile }: { onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (!file.type.startsWith("video/") && !/\.(mp4|webm|mov|mkv|m4v)$/i.test(file.name)) {
        alert("Please choose a video file.");
        return;
      }
      onFile(file);
    },
    [onFile]
  );

  return (
    <div className="flex flex-1 items-center justify-center bg-gradient-to-b from-zinc-50 to-neutral-50/50 p-6">
      <div className="w-full max-w-xl">
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white/80 px-8 py-14 text-center transition ${
            dragging
              ? "border-neutral-500 bg-neutral-50/80"
              : "border-zinc-300 hover:border-neutral-400 hover:bg-white"
          }`}
        >
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-100 text-neutral-600">
            <Upload size={20} />
          </div>
          <p className="text-[15px] font-medium text-zinc-800">
            Drop a video here, or <span className="text-neutral-600">browse</span>
          </p>
          <p className="mt-1 text-[13px] text-zinc-400">MP4, WebM or MOV with an audio track</p>
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            { icon: Type, title: "Transcribe", text: "Per-word timing and speaker labels." },
            { icon: Scissors, title: "Edit", text: "Select words and hit delete to edit." },
            { icon: Clapperboard, title: "Export", text: "Render the final cut to MP4." },
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
          No uploads, no accounts — your video never leaves this device.
        </p>
      </div>
    </div>
  );
}
