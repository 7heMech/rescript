# Rescript

**Edit video by editing text — fully offline, in your browser.**

Rescript is an open-source, transcript-based video editor. Drop in a video and
it is transcribed locally with per-word timestamps and speaker labels. Delete
words in the transcript and the corresponding clip is cut from the video.
Export the final cut to MP4 — without your video ever leaving your device.

- 🔒 **Private by design** — no server, no auth, no API calls, no uploads
- 📝 **Word-level editing** — select words, press ⌫, the cut follows the text
- 🗣️ **Speaker diarization** — the transcript is grouped by speaker
- 🎬 **Timeline** — waveform, word labels, cut regions, playhead, zoom
- ⚡ **Live preview** — playback skips your cuts in real time
- 📦 **In-browser export** — frame-accurate MP4 render with ffmpeg.wasm

## Stack

| Piece | Tech |
| --- | --- |
| App | [Next.js](https://nextjs.org) + React + TypeScript + Tailwind |
| Transcription | [transformers.js](https://github.com/huggingface/transformers.js) running [`whisper-base_timestamped`](https://huggingface.co/onnx-community/whisper-base_timestamped) (WebGPU with WASM fallback) in a Web Worker |
| Speaker labels | [`pyannote-segmentation-3.0`](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) (ONNX) |
| Media processing | [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) (multi-threaded) for audio extraction and export |
| State | zustand |

## Getting started

```bash
npm install   # also copies ffmpeg/onnxruntime WASM into public/vendor
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and drop in a video with an
audio track.

> **Note on "offline":** the AI models (~90 MB total) are downloaded from the
> Hugging Face Hub the *first* time you transcribe, then cached in browser
> storage. After that, everything — transcription, editing, export — works with
> the network fully disconnected. The app itself never makes API calls.

## How it works

1. **Extract** — ffmpeg.wasm decodes the audio track to mono 16 kHz PCM.
2. **Transcribe** — Whisper runs in a Web Worker with `return_timestamps: "word"`,
   streaming text as it goes; pyannote assigns a speaker to every word.
3. **Edit** — deleting words produces "cut ranges" of the original media. The
   preview player skips them in real time and the timeline shows them in red.
4. **Export** — the kept ranges are trimmed and concatenated with an ffmpeg
   filter graph and re-encoded (`libx264`/`aac`), so cuts are word-accurate.

See [PLAN.md](./PLAN.md) for architecture details and the roadmap.

## Browser support

A Chromium-based browser is recommended. The app requires `SharedArrayBuffer`
(served with COOP/COEP headers) and uses WebGPU for inference when available,
falling back to WASM otherwise.

## Development

```bash
npm run dev     # dev server
npm run build   # production build
npm run lint    # eslint
```

## License

MIT
