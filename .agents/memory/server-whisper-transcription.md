---
name: Server-side Whisper transcription
description: How server ASR runs on the API artifact, and the native-dep pitfalls that break its esbuild bundle.
---

# Server-side Whisper transcription

The API server (`artifacts/api-server`) runs Whisper Base/Small on the CPU via
`@huggingface/transformers`, in a `worker_threads` worker, as an async job queue
(upload → poll status → words). Parakeet stays browser-only. The frontend picks
the backend in `Editor.tsx` via `usesServerTranscription(source)` (whisper →
server, parakeet → browser worker).

**Why a worker thread + job queue:** CPU inference blocks; the queue caps
concurrency (`TRANSCRIBE_CONCURRENCY`, default 1) and reaps terminal/stale jobs
on a TTL so abandoned uploads don't leak.

## esbuild bundling pitfalls (the part that cost the most time)

`@huggingface/transformers` pulls native deps that a bundled worker cannot
`import` unless they resolve at runtime:

- **`onnxruntime-node`** must be an esbuild `external` AND a *direct* dependency
  of `api-server`. It is only a transitive dep of transformers otherwise, so a
  bare external import from `dist/` fails with "Cannot find package". Make sure
  the package manager builds its native addon. The Node build uses `device:
  "cpu"`, NOT `"wasm"` (wasm throws
  "Unsupported device" — that string is browser-only).
- **`sharp`** is lazily imported for image inputs the ASR path never hits, and it
  is an unbuilt native addon. Do NOT externalize it (unresolvable at runtime) —
  stub it to an empty module with an esbuild `onResolve`/`onLoad` plugin.

**Why:** externalizing a native dep only works if Node can resolve it from the
emitted file's location; transitive natives are not guaranteed to be resolvable
from the artifact's `dist/`. Direct-dep + external for the one we use, stub for
the ones we don't.

## Worker entry path after bundling

The worker is a second esbuild entry → `dist/transcribe/worker.mjs`. `jobs.ts`
lives in `dist/index.mjs` after bundling, so spawn it with
`new URL("./transcribe/worker.mjs", import.meta.url)`, not `./worker.mjs`.

## OpenAPI codegen gotchas (zod v3 + orval v8)

- orval emits `zod.int()` (zod v4) which zod 3.25 lacks → use `type: number`, not
  `integer`, for numeric schema fields.
- A `format: binary` multipart field emits `zod.instanceof(File)` and a `Blob`
  TS type, neither of which exist in the Node lib → keep the file OUT of the
  OpenAPI body schema; multer validates the upload, and the generated upload
  helper only serializes non-file fields anyway (so the frontend builds its own
  FormData with the file — see `useServerTranscriber.ts`).
- The `api-zod` barrel re-exports schema *values* from `generated/api.ts` named
  after the operation response (`UploadTranscriptionResponse`,
  `GetTranscriptionStatusResponse`), while the entity names (`TranscribeJob`,
  `TranscribeStatus`) are TS-only interfaces. Import the response-named values
  server-side for `.parse()`.

## Isolation

Server transcription still relies on ffmpeg-in-browser for the waveform
envelope, so the cross-origin-isolation (SharedArrayBuffer) gate stays. Only the
transcription *inference* moved off the browser; the waveform/export isolation
requirement is unchanged.
