/**
 * Copies WASM runtime assets from node_modules into public/ so the app can be
 * served fully offline (no CDN requests at runtime):
 *   - @ffmpeg/core-mt  -> public/vendor/ffmpeg/  (audio extraction + export)
 *   - onnxruntime-web  -> public/vendor/ort/     (transformers.js inference)
 * Runs automatically on `npm install` (postinstall).
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ffmpegSrc = join(root, "node_modules/@ffmpeg/core-mt/dist/esm");
const ffmpegDst = join(root, "public/vendor/ffmpeg");
mkdirSync(ffmpegDst, { recursive: true });
for (const f of readdirSync(ffmpegSrc)) {
  cpSync(join(ffmpegSrc, f), join(ffmpegDst, f));
}

const ortSrc = join(root, "node_modules/onnxruntime-web/dist");
const ortDst = join(root, "public/vendor/ort");
mkdirSync(ortDst, { recursive: true });
for (const f of readdirSync(ortSrc)) {
  if (/^ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs)$/.test(f)) {
    cpSync(join(ortSrc, f), join(ortDst, f));
  }
}

console.log("[copy-assets] ffmpeg core + onnxruntime wasm copied to public/vendor");
