import { isNetworkError, installFetchRetry } from "../lib/network";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

{
  // The three engine wordings, as reported by RESCRIPT-9 (Electron/Windows) and
  // their Firefox / WebKit equivalents.
  assert(isNetworkError(new TypeError("Failed to fetch")), "chromium wording");
  assert(
    isNetworkError(
      new TypeError("NetworkError when attempting to fetch resource."),
    ),
    "firefox wording",
  );
  assert(isNetworkError(new TypeError("Load failed")), "webkit wording");
  assert(
    isNetworkError("net::ERR_INTERNET_DISCONNECTED"),
    "chromium net error code",
  );
  // transformers.js / onnxruntime wrap the original message in their own.
  assert(
    isNetworkError(
      new Error(
        "Error: no available backend found. ERR: [wasm] TypeError: Failed to fetch",
      ),
    ),
    "wrapped message should still match",
  );
}

{
  assert(
    !isNetworkError(new Error("Parakeet WebGPU/fp16 model load failed")),
    "'load failed' inside a longer message is not a network error",
  );
  assert(
    !isNetworkError(new Error("404 Not Found")),
    "http status is a real answer",
  );
  assert(
    !isNetworkError(new Error("Unknown speech model: base")),
    "unrelated error",
  );
  assert(!isNetworkError(null), "null");
  assert(!isNetworkError(""), "empty");
}

// installFetchRetry: replays GETs that fail at the transport layer. Wrapped in
// a function because the retries are awaited and tsx compiles these to CJS.
async function retryChecks() {
  {
    let calls = 0;
    const scope = {
      fetch: (async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    };
    installFetchRetry(scope);
    const res = await scope.fetch("https://huggingface.co/model.onnx");
    assert(
      res.ok && calls === 2,
      `transient failure should be retried (calls=${calls})`,
    );

    // Second install on the same scope must not double-wrap.
    installFetchRetry(scope);
    calls = 0;
    await scope.fetch("https://huggingface.co/model.onnx");
    assert(calls === 2, `install should be idempotent (calls=${calls})`);
  }

  {
    // A non-network throw is passed straight through.
    let calls = 0;
    const scope = {
      fetch: (async () => {
        calls += 1;
        throw new Error("Refused to connect: bad scheme");
      }) as unknown as typeof fetch,
    };
    installFetchRetry(scope);
    let threw = false;
    try {
      await scope.fetch("https://huggingface.co/model.onnx");
    } catch {
      threw = true;
    }
    assert(
      threw && calls === 1,
      `non-network error should not retry (calls=${calls})`,
    );
  }

  {
    // Bodies cannot be replayed, so non-idempotent methods are left alone.
    let calls = 0;
    const scope = {
      fetch: (async () => {
        calls += 1;
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    };
    installFetchRetry(scope);
    try {
      await scope.fetch("/api/telemetry", { method: "POST", body: "{}" });
    } catch {
      // expected
    }
    assert(calls === 1, `POST should not retry (calls=${calls})`);
  }

  {
    // An abort is a decision, not a failure.
    let calls = 0;
    const scope = {
      fetch: (async () => {
        calls += 1;
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
    };
    installFetchRetry(scope);
    const controller = new AbortController();
    controller.abort();
    try {
      await scope.fetch("https://huggingface.co/model.onnx", {
        signal: controller.signal,
      });
    } catch {
      // expected
    }
    assert(calls === 1, `aborted request should not retry (calls=${calls})`);
  }
}

retryChecks().then(
  () => console.log("network-test: ok"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
