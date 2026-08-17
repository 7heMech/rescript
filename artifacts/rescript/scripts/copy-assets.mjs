/**
 * Copies WASM runtime assets from node_modules into public/ so the app can be
 * served fully offline (no CDN requests at runtime):
 *   - @ffmpeg/core-mt  -> public/vendor/ffmpeg/  (audio extraction + export)
 *   - @ffmpeg/ffmpeg   -> public/vendor/ffmpeg-class/ (class worker ESM build)
 *   - onnxruntime-web  -> public/vendor/ort/     (transformers.js inference)
 *   - parakeet.js ORT  -> public/vendor/ort-parakeet/ (Parakeet TDT inference)
 *   - assets/aaf       -> public/vendor/aaf/     (Pro Tools / Logic AAF scaffold)
 * Also patches parakeet.js initOrt to honor the wasmPaths argument.
 * Run manually after (re)installing dependencies: node scripts/copy-assets.mjs
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolve a package's real directory through pnpm symlinks, walking up from
 *  `base` until a node_modules containing the package is found. */
function pkgDir(base, name) {
  let dir = realpathSync(base);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Cannot resolve package ${name} from ${base}`);
    }
    dir = parent;
  }
}

const ffmpegSrc = join(root, "node_modules/@ffmpeg/core-mt/dist/esm");
const ffmpegDst = join(root, "public/vendor/ffmpeg");
mkdirSync(ffmpegDst, { recursive: true });
for (const f of readdirSync(ffmpegSrc)) {
  cpSync(join(ffmpegSrc, f), join(ffmpegDst, f));
}

// The @ffmpeg/ffmpeg "class worker" contains a dynamic import() that bundlers
// cannot process; serve the package's own ESM build and point classWorkerURL
// at it instead (see lib/ffmpeg.ts).
const ffmpegClassSrc = join(root, "node_modules/@ffmpeg/ffmpeg/dist/esm");
const ffmpegClassDst = join(root, "public/vendor/ffmpeg-class");
mkdirSync(ffmpegClassDst, { recursive: true });
for (const f of readdirSync(ffmpegClassSrc)) {
  if (f.endsWith(".js") || f.endsWith(".mjs")) {
    cpSync(join(ffmpegClassSrc, f), join(ffmpegClassDst, f));
  }
}

function copyOrtWasm(srcDist, dst) {
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(srcDist)) {
    if (/^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f)) {
      cpSync(join(srcDist, f), join(dst, f));
    }
  }
}

// transformers.js pins its own onnxruntime-web version; resolve it through
// the @huggingface/transformers dependency chain so versions stay matched.
const hfDir = pkgDir(root, "@huggingface/transformers");
const hfOrtDist = join(pkgDir(hfDir, "onnxruntime-web"), "dist");
copyOrtWasm(hfOrtDist, join(root, "public/vendor/ort"));

// Parakeet.js pins onnxruntime-web@1.24.1. Keep its WASM separate so the JS
// package and binaries stay version-matched.
const parakeetDir = pkgDir(root, "parakeet.js");
const parakeetOrtDist = join(pkgDir(parakeetDir, "onnxruntime-web"), "dist");
copyOrtWasm(parakeetOrtDist, join(root, "public/vendor/ort-parakeet"));

/*
 * The behavioral fixes to parakeet.js (initOrt honoring wasmPaths) and
 * @huggingface/transformers (Whisper timestamp handling) are applied
 * declaratively via pnpm `patchedDependencies` (see /pnpm-workspace.yaml and
 * /patches). Verify they took effect and fail the install loudly if not —
 * without them transcription silently falls back to CDN assets or produces
 * garbled Whisper timestamps.
 */
const parakeetBackend = join(parakeetDir, "src/backend.js");
if (
  !existsSync(parakeetBackend) ||
  !readFileSync(parakeetBackend, "utf8").includes("rescript-wasmPaths-patch")
) {
  throw new Error(
    "[copy-assets] parakeet.js is missing the wasmPaths patch. " +
      "Check patchedDependencies in pnpm-workspace.yaml and reinstall."
  );
}
const hfBundle = join(hfDir, "dist/transformers.js");
if (
  !existsSync(hfBundle) ||
  !readFileSync(hfBundle, "utf8").includes("timestamp_end")
) {
  throw new Error(
    "[copy-assets] @huggingface/transformers is missing the Whisper timestamp patch. " +
      "Check patchedDependencies in pnpm-workspace.yaml and reinstall."
  );
}

// Sanity-check the vendored outputs so a broken copy fails now, not at runtime.
for (const required of [
  "public/vendor/ffmpeg/ffmpeg-core.wasm",
  "public/vendor/ffmpeg-class/worker.js",
  "public/vendor/ort/ort-wasm-simd-threaded.mjs",
  "public/vendor/ort-parakeet/ort-wasm-simd-threaded.wasm",
]) {
  if (!existsSync(join(root, required))) {
    throw new Error(`[copy-assets] Expected vendored asset missing: ${required}`);
  }
}

console.log(
  "[copy-assets] ffmpeg core + onnxruntime wasm copied to public/vendor; dependency patches verified"
);
