/**
 * Network-failure detection and download retries.
 *
 * Model weights are fetched from the Hub the first time a model runs — up to
 * 1.3 GB for Parakeet fp16 — so a single dropped connection anywhere in that
 * transfer used to abort the whole transcription with a bare "Failed to fetch".
 */

/**
 * True for failures that mean the request never completed — the network
 * dropped, DNS failed, the connection reset — as opposed to a response that
 * arrived and was unwelcome (those surface as an `ok: false` Response, not a
 * throw).
 *
 * Matching on the message is the only option: fetch rejects with a bare
 * `TypeError` carrying no code, and the wording is engine-specific — Chromium
 * and Electron say "Failed to fetch", Firefox "NetworkError when attempting to
 * fetch resource", WebKit just "Load failed". Chromium sometimes appends the
 * underlying `net::ERR_*` instead, and onnxruntime / transformers.js wrap the
 * original message in their own, so these are substring tests.
 */
export function isNetworkError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const msg = raw.toLowerCase().trim();
  if (!msg) return false;
  // WebKit's entire message. Left as an exact match because "load failed" as a
  // substring also describes plenty of non-network failures ("model load
  // failed"), and mislabelling those as offline sends the user chasing their
  // router instead of reporting a bug.
  if (msg === "load failed") return true;
  return (
    msg.includes("failed to fetch") ||
    msg.includes("networkerror when attempting to fetch") ||
    msg.includes("network request failed") ||
    msg.includes("the network connection was lost") ||
    msg.includes("err_internet_disconnected") ||
    msg.includes("err_network_changed") ||
    msg.includes("err_name_not_resolved") ||
    msg.includes("err_connection_") ||
    msg.includes("err_timed_out") ||
    msg.includes("err_address_unreachable")
  );
}

/** Backoff before each retry; length also caps the number of attempts. */
const RETRY_DELAYS_MS = [500, 2_000, 6_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a scope's `fetch` so requests that fail at the transport layer are
 * retried with backoff.
 *
 * Only network-class rejections are retried. An HTTP error is a real answer and
 * is returned untouched; an abort is a decision, not a failure. Retries are
 * limited to GET/HEAD, which are the only requests here (weights, ORT WASM) and
 * the only ones safe to replay without a body to re-send.
 *
 * Idempotent per scope, so importing this from more than one place is harmless.
 * Returns the wrapped function, for libraries that snapshot `globalThis.fetch`
 * at import time and so never see the replacement (transformers.js keeps its own
 * `env.fetch` this way).
 */
export function installFetchRetry(scope: {
  fetch: typeof fetch;
  __fetchRetryInstalled?: boolean;
}): typeof fetch {
  if (scope.__fetchRetryInstalled) return scope.fetch;
  scope.__fetchRetryInstalled = true;

  const original = scope.fetch.bind(scope) as typeof fetch;

  scope.fetch = async (input, init) => {
    const method = (
      init?.method ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.method
        : "GET")
    ).toUpperCase();
    const replayable = method === "GET" || method === "HEAD";

    for (let attempt = 0; ; attempt++) {
      try {
        return await original(input, init);
      } catch (err) {
        const signal =
          init?.signal ??
          (typeof Request !== "undefined" && input instanceof Request
            ? input.signal
            : undefined);
        if (
          signal?.aborted ||
          !replayable ||
          !isNetworkError(err) ||
          attempt >= RETRY_DELAYS_MS.length
        ) {
          throw err;
        }
        const wait = RETRY_DELAYS_MS[attempt];
        console.warn(
          `Network request failed; retrying in ${wait}ms ` +
            `(attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1}).`,
          err
        );
        await sleep(wait);
      }
    }
  };

  return scope.fetch;
}
