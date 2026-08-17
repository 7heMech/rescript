---
name: Rescript WASM vendoring
description: Dependency patches and vendored WASM for Rescript must stay reproducibly enforced by the install lifecycle, never manual.
---

**Rule:** Anything Rescript's offline transcription needs beyond published packages — behavioral fixes to parakeet.js / @huggingface/transformers and the same-origin WASM copies under `public/vendor/` — must be enforced declaratively by the install lifecycle (pnpm `patchedDependencies` + the package `prepare` script, which verifies and fails loudly), never applied as one-off shell commands.

**Why:** A code review rejected the initial port because the patches were manual mutations of node_modules: the app built fine, but any clean install silently reverted to CDN-fetching parakeet.js and broken Whisper timestamps — a runtime-only regression invisible to typecheck/build.

**How to apply:** When adding another patched dependency or vendored runtime asset to Rescript, wire it through `patchedDependencies` (or extend `scripts/copy-assets.mjs`, which runs on `prepare`) and add a verification check that throws when the patch/asset is absent. transformers.js and parakeet.js pin *different* onnxruntime-web versions — keep `vendor/ort` and `vendor/ort-parakeet` separate.

Related durable gotchas from the Next→Vite port:
- SharedArrayBuffer (multi-threaded ffmpeg.wasm + threaded ONNX) requires COOP/COEP headers; production hosting must send them too or transcription breaks only in prod.
- The Replit cartographer Babel plugin cannot parse generic JSX call syntax (`<Comp<T> ...>`) — it crashes the dev server with "Unexpected token". Use typed lambda props instead.
