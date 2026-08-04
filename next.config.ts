import type { NextConfig } from "next";

// STATIC_EXPORT=1 emits the static bundle shipped to both targets: the web app
// at app.getrescript.com (served by Vercel, which sends the cross-origin
// isolation headers from vercel.json) and the Electron shell (which sets them
// itself in electron/main.ts). Both serve from the root, so there is no
// basePath. The headers() below only covers `next dev`, where neither applies.
const isExport = process.env.STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
        // cross-origin-isolated contexts. COEP "credentialless" (rather than
        // "require-corp") keeps the page cross-origin isolated while still
        // allowing third-party scripts like Google Analytics, which don't
        // send Cross-Origin-Resource-Policy headers.
        async headers() {
          return [
            {
              source: "/(.*)",
              headers: [
                { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
                { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
