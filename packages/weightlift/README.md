# weightlift

Framework-agnostic progress state for **in-browser ML model loading**.

Transformers.js, WebLLM, and whisper.cpp WASM each expose their own progress
callbacks. Everyone ends up hand-rolling the same ~100 lines: aggregate
multi-file downloads into one percentage, tolerate missing `Content-Length`,
dedupe concurrent loads, and shuttle events out of a web worker.

**weightlift** is that thin layer — a zero-dependency TypeScript core plus a
15-line React adapter.

```ts
import { Weightlift } from "weightlift";
import { transformersAdapter } from "weightlift/adapters/transformers";

const wl = new Weightlift();
wl.subscribe((s) => {
  console.log(s.status, s.percent, s.message);
});

wl.start("Downloading speech model…");
await pipeline("automatic-speech-recognition", modelId, {
  progress_callback: transformersAdapter(wl),
});
wl.ready();
```

## Install

```bash
npm install weightlift
```

React is an **optional** peer dependency — only needed for `weightlift/react`.

## Package exports

| Import | What |
| --- | --- |
| `weightlift` | Core store, reducer, loader helpers, adapter re-exports |
| `weightlift/react` | `useWeightlift` / `useWeightliftStore` (`useSyncExternalStore`) |
| `weightlift/adapters/transformers` | `transformersAdapter()` for `progress_callback` |
| `weightlift/adapters/webllm` | `webllmAdapter()` for `initProgressCallback` |
| `weightlift/worker` | `createWorkerReporter` / `attachWorker` postMessage bridge |

## State shape

```ts
interface WeightliftState {
  status: "idle" | "loading" | "ready" | "error";
  message: string;
  files: Record<string, { loaded: number; total: number | null; status: string }>;
  loadedBytes: number;
  totalBytes: number | null;
  percent: number | null;     // 0..1, or null when indeterminate
  indeterminate: boolean;
  error: Error | null;
}
```

Files download in parallel, and totals are sometimes missing — when no usable
byte total is known, `percent` is `null` and `indeterminate` is `true`.

## React

```tsx
import { useMemo } from "react";
import { Weightlift } from "weightlift";
import { useWeightlift } from "weightlift/react";

function ModelBar({ weightlift }: { weightlift: Weightlift }) {
  const { percent, message, indeterminate, isLoading } = useWeightlift(weightlift);
  if (!isLoading) return null;
  return (
    <div>
      <p>{message}</p>
      <progress value={indeterminate ? undefined : percent ?? 0} max={1} />
    </div>
  );
}
```

## Web worker

Model loads belong in a worker; the UI lives on the main thread. weightlift
ships the glue:

```ts
// worker.ts
import { Weightlift } from "weightlift";
import { transformersAdapter } from "weightlift/adapters/transformers";
import { createWorkerReporter } from "weightlift/worker";

const wl = new Weightlift();
const reporter = createWorkerReporter(self, wl, { mode: "event" });
wl.start("Downloading…");

await pipeline("automatic-speech-recognition", id, {
  progress_callback: transformersAdapter(reporter),
});
wl.ready();
```

```ts
// main.ts
import { Weightlift } from "weightlift";
import { attachWorker } from "weightlift/worker";
import { useWeightlift } from "weightlift/react";

const wl = new Weightlift();
attachWorker(worker, wl);
```

## Deduping loads

```ts
import { createModelRegistry } from "weightlift";

const registry = createModelRegistry<Pipeline>();

export function getAsr(modelId: string) {
  return registry
    .get(modelId, async (wl) => {
      wl.start("Downloading…");
      return pipeline("automatic-speech-recognition", modelId, {
        progress_callback: transformersAdapter(wl),
      });
    })
    .load();
}
```

## Why not React-first?

Hooks cannot run inside web workers, and that is where model loading happens.
A vanilla subscription store + `useSyncExternalStore` binding is the same
pattern Zustand, TanStack Query, and Jotai use — one core, many frameworks.

## License

MIT
