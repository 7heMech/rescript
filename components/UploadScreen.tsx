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
    <div className="flex flex-1 items-center justify-center bg-gradient-to-b from-zinc-50 to-indigo-50/50 p-6">
      <div className="w-full max-w-xl">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-2xl font-bold text-white shadow-lg shadow-indigo-200">
            R
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">Rescript</h1>
          <p className="mt-2 max-w-md text-[15px] leading-relaxed text-zinc-500">
            Edit video by editing text. Delete a word in the transcript and it&apos;s cut
            from the video — all in your browser, completely offline.
          </p>
        </div>

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
          className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-white/80 px-8 py-14 text-center shadow-sm backdrop-blur transition ${
            dragging
              ? "border-indigo-500 bg-indigo-50/80"
              : "border-zinc-300 hover:border-indigo-400 hover:bg-white"
          }`}
        >
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
            <Upload size={20} />
          </div>
          <p className="text-[15px] font-medium text-zinc-800">
            Drop a video here, or <span className="text-indigo-600">browse</span>
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
            { icon: Type, title: "Transcribe", text: "Whisper runs locally with per-word timing and speaker labels" },
            { icon: Scissors, title: "Edit", text: "Select words and hit delete — the video cut follows the text" },
            { icon: Clapperboard, title: "Export", text: "Render the final cut to MP4 with ffmpeg, in the browser" },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-xl border border-zinc-200 bg-white/70 p-4">
              <Icon size={16} className="mb-2 text-indigo-500" />
              <p className="text-[13px] font-semibold text-zinc-800">{title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{text}</p>
            </div>
          ))}
        </div>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-zinc-400">
          <Lock size={12} />
          No uploads, no accounts, no API calls — your video never leaves this device.
        </p>
      </div>
    </div>
  );
}
