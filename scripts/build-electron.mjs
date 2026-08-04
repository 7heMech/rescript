#!/usr/bin/env node
/**
 * Bundle Electron main + preload into electron-dist/ so the packaged app
 * does not need to ship the whole Next.js / ffmpeg / transformers node_modules
 * tree (those already live inside the static `out/` export for the renderer).
 */
import { build } from "esbuild";
import { mkdirSync, rmSync } from "node:fs";

rmSync("electron-dist", { recursive: true, force: true });
mkdirSync("electron-dist", { recursive: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
  define: {
    // The packaged app has no build-time env, so the DSN has to be baked in.
    // Same variable as the renderer, so there is only one thing to configure.
    "process.env.NEXT_PUBLIC_SENTRY_DSN": JSON.stringify(
      process.env.NEXT_PUBLIC_SENTRY_DSN ?? ""
    ),
  },
};

await build({
  ...shared,
  entryPoints: ["electron/main.ts"],
  outfile: "electron-dist/main.js",
  format: "cjs",
});

await build({
  ...shared,
  entryPoints: ["electron/preload.ts"],
  outfile: "electron-dist/preload.js",
  format: "cjs",
});

console.log("[build-electron] wrote electron-dist/main.js + preload.js");
