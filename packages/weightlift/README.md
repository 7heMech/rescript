# weightlift

In-browser **ML model manager** with download progress — for Transformers.js,
WebLLM, whisper.cpp WASM, and friends.

The thing every app hand-rolls: singleton loads by model id, cache-hit
labeling, multi-file progress aggregation, `isLoading` / `isReady`, and
shuttling state out of a web worker. Zero runtime dependencies; React is an
optional peer.

```ts
import { ModelManager } from "weightlift";
import { transformersAdapter } from "weightlift/adapters/transformers";

const models = new ModelManager();

models.define("whisper-base", {
  isCached: () => isOnnxCached("onnx-community/whisper-base_timestamped"),
  messages: {
    download: "Downloading speech model…",
    cache: "Loading speech model from cache…",
  },
  load: async ({ progress }) =>
    pipeline("automatic-speech-recognition", "onnx-community/whisper-base_timestamped", {
      progress_callback: transformersAdapter(progress),
    }),
});

const asr = await models.load("whisper-base");
// concurrent load("whisper-base") shares the same promise
```

## Install

```bash
npm install weightlift
```

## Package exports

| Import | What |
| --- | --- |
| `weightlift` | **`ModelManager`** (headline API), plus low-level `Weightlift` progress store |
| `weightlift/react` | `useModel` / `useModelManager` (`useSyncExternalStore`) |
| `weightlift/adapters/transformers` | `transformersAdapter()` for `progress_callback` |
| `weightlift/adapters/webllm` | `webllmAdapter()` for `initProgressCallback` |
| `weightlift/worker` | `createWorkerReporter` / `attachWorker` postMessage bridge |

## ModelManager

| Method | Purpose |
| --- | --- |
| `define(id, definition)` | Register how to load (and optionally dispose) a model |
| `load(id)` / `load(id, definition)` | Load once; dedupe concurrent callers; lazy-define overload |
| `get(id)` | Sync access to a ready instance |
| `status(id)` | `{ status, percent, message, fromCache, … }` for UI |
| `isReady` / `isLoading` / `has` | Quick queries |
| `unload(id)` | Drop instance (calls `dispose`) so the next `load` re-runs |
| `preload([ids])` | Warm several models |
| `subscribe` / `getSnapshot` | Manager-wide snapshot for React / vanilla UI |

### Definition shape

```ts
interface ModelDefinition<T> {
  load: (ctx: {
    id: string;
    progress: Weightlift;      // pass to transformersAdapter(progress)
    fromCache: boolean | null;
  }) => Promise<T>;
  isCached?: () => boolean | Promise<boolean>;
  dispose?: (value: T) => void | Promise<void>;
  messages?: { download?: string; cache?: string; ready?: string };
}
```

## React

```tsx
import { useModel, useModelManager } from "weightlift/react";

function ModelBar({ manager }: { manager: ModelManager }) {
  const { percent, message, isLoading, load } = useModel(manager, "whisper-base");

  return (
    <div>
      {isLoading ? (
        <>
          <p>{message}</p>
          <progress value={percent ?? undefined} max={1} />
        </>
      ) : (
        <button onClick={() => load()}>Load model</button>
      )}
    </div>
  );
}
```

## Web worker

Loads belong in a worker; the UI lives on the main thread. Each model’s
`progress` store can be bridged with `weightlift/worker`:

```ts
// worker.ts
const models = new ModelManager();
models.define("whisper-base", {
  load: async ({ progress }) => {
    createWorkerReporter(self, progress, { mode: "event" });
    return pipeline(task, id, {
      progress_callback: transformersAdapter(progress),
    });
  },
});

// main.ts
const progress = new Weightlift();
attachWorker(worker, progress);
```

Or subscribe to the manager in the worker and `postMessage` `manager.getSnapshot()` yourself — the snapshot is plain JSON-serializable fields (aside from `error`).

## Low-level progress store

`Weightlift` is the per-model progress engine under the manager (also usable
standalone if you only need a progress bar). It aggregates parallel file
downloads into `{ percent, loadedBytes, totalBytes, indeterminate, files }`,
prefers transformers.js `progress_total` events, and stays indeterminate when
`Content-Length` is missing.

## Why not React-first?

Hooks cannot run inside web workers, and that is where model loading happens.
Vanilla core + `useSyncExternalStore` bindings is the same pattern as Zustand /
TanStack Query — one core, many frameworks.

## License

MIT
