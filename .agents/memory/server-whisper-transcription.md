---
name: Server-side Whisper transcription
description: Durable operational rules for CPU speech recognition, native ONNX dependencies, and generated API contracts.
---

# Server-side speech recognition

Server CPU transcription is an asynchronous job-queue capability. Browser
transcription remains a fallback because waveform extraction, alignment, and
export still depend on browser isolation.

**Native worker lifecycle:** Keep one persistent worker per backend and route
jobs to an idle worker. Do not repeatedly load the same native ONNX addon in
fresh worker threads within one Node process; the second load can fail with
“Module did not self-register”.

**Why:** CPU inference must stay off the API event loop, while native addon
initialization is not reliably repeatable across short-lived worker threads.
Backend-specific workers also prevent an unused native backend from
contaminating another backend's bundle.

**How to apply:** Bound the global queue, gate each backend worker to one active
job, release a slot only when a job is terminal, and keep a cancelled worker's
slot occupied until its current run unwinds.

## Native dependency bundling

Native packages used by a bundled worker must be direct dependencies and remain
external so Node resolves the addon at runtime. Native packages imported only by
unreachable code should be stubbed rather than externalized. Always use the CPU
runtime explicitly for Node inference; browser WASM device settings do not
transfer to the server.

## Generated API contracts

Keep multipart file handling in the server upload middleware when generated
OpenAPI schemas produce browser-only `File`/`Blob` types. Validate generated
response values with the response-named runtime schemas; entity names may be
type-only interfaces.

## Isolation

Moving inference to the server does not remove the browser's
cross-origin-isolation requirement: ffmpeg waveform extraction and export still
use `SharedArrayBuffer`.