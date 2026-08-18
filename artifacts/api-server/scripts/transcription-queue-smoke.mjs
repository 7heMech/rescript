import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const port = 8091;
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = await mkdtemp(path.join(tmpdir(), "rescript-queue-test-"));
const wavPath = path.join(tempDir, "fixture.wav");

function makeWav() {
  const sampleRate = 16_000;
  const samples = new Int16Array(sampleRate);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer)]);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fetch(`${baseUrl}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("API server did not start");
}

async function submit() {
  const body = new FormData();
  body.set("model", "base");
  body.set("language", "en");
  body.set(
    "file",
    new Blob([await readFile(wavPath)], { type: "audio/wav" }),
    "fixture.wav",
  );
  const response = await fetch(`${baseUrl}/api/transcribe/upload`, {
    method: "POST",
    body,
  });
  assert.equal(response.status, 202);
  return (await response.json()).jobId;
}

async function waitForDone(jobId) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`${baseUrl}/api/transcribe/${jobId}/status`);
    const status = await response.json();
    if (status.state === "done" || status.state === "error") return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state`);
}

await writeFile(wavPath, makeWav());
const server = spawn(process.execPath, ["./dist/index.mjs"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: {
    ...process.env,
    PORT: String(port),
    TRANSCRIBE_CONCURRENCY: "2",
  },
  stdio: "ignore",
});

try {
  await waitForServer();
  const jobIds = [await submit(), await submit()];
  const statuses = await Promise.all(jobIds.map(waitForDone));
  for (const status of statuses) {
    assert.equal(status.state, "done", status.error ?? "transcription failed");
    assert.ok(Array.isArray(status.words));
  }
  console.log("transcription queue smoke test passed");
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    once(server, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  await rm(tempDir, { recursive: true, force: true });
}