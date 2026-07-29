#!/usr/bin/env node
/**
 * Wait until the Next.js dev server responds, then launch Electron.
 * Used by `npm run electron:dev` so the window doesn't race the server.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const url = process.env.ELECTRON_START_URL ?? "http://localhost:3000";
const timeoutMs = 60_000;
const start = Date.now();

async function waitForServer() {
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      // Any HTTP response means the server is up (even 404 / 500).
      if (res.status > 0) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

await waitForServer();
const child = spawn(String(electronPath), ["."], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_START_URL: url },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
