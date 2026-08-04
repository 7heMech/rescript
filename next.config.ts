import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

// Telemetry reports which version is in use, so the client needs the version at
// build time. Read from package.json rather than duplicated in a constant that
// `npm version` would silently leave stale.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string };

// STATIC_EXPORT=1 emits the static bundle shipped to both targets: the web app
// at app.getrescript.com (served by Vercel, which sends the cross-origin
// isolation headers from vercel.json) and the Electron shell (which sets them
// itself in electron/main.ts). Both serve from the root, so there is no
// basePath. The headers() below only covers `next dev`, where neither applies.
const isExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Sentry stack traces are unreadable against a minified bundle. The source is
  // public anyway, so serving maps costs no secrecy and saves an upload step for
  // the web build — Sentry fetches them from app.getrescript.com on demand.
  productionBrowserSourceMaps: true,
  // Inlined into the client bundle at build time (both targets are static, so
  // there is no runtime env to read this from).
  env: { NEXT_PUBLIC_APP_VERSION: version },
  // parakeet.js ships as raw ESM from src/; transpile for the worker bundle.
  transpilePackages: ["parakeet.js"],
  ...(isExport
    ? {
        output: "export" as const,
        images: { unoptimized: true },
      }
    : {
        // SharedArrayBuffer (required by ffmpeg.wasm multi-threading and
        // onnxruntime multi-threading) is only available in
        // cross-origin-isolated contexts. It has to be "require-corp" rather
        // than the laxer "credentialless": WebKit never shipped credentialless
        // and treats it as unsafe-none, which left every Safari user staring at
        // "This browser can't run the editor". Every cross-origin subresource
        // we load opts in — gtag.js and the analytics proxy on
        // www.getrescript.com both send Cross-Origin-Resource-Policy, and model
        // downloads are CORS-mode fetches, which COEP allows regardless.
        async headers() {
          return [
            {
              source: "/(.*)",
              headers: [
                { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
                { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
