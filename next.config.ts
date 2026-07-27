import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // SharedArrayBuffer (required by ffmpeg.wasm multi-threading and onnxruntime
  // multi-threading) is only available in cross-origin-isolated contexts.
  // COEP "credentialless" (rather than "require-corp") keeps the page
  // cross-origin isolated while still allowing third-party scripts like
  // Google Analytics, which don't send Cross-Origin-Resource-Policy headers.
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
};

export default nextConfig;
