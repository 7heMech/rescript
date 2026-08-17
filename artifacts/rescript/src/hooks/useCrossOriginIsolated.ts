
import { useSyncExternalStore } from "react";

export type IsolationState = "checking" | "ready" | "unavailable";

function isIsolated() {
  return self.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
}

// Module-level store: isolation is a property of the page, not of any component,
// and it only ever moves from "checking" to a settled value once.
let state: IsolationState = "checking";
const listeners = new Set<() => void>();
let watching = false;

function emit(next: IsolationState) {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!watching) {
    watching = true;
    // Isolation is decided by the response headers of the document itself, so it
    // is already settled by the time any component mounts — there is nothing to
    // poll for or wait on.
    emit(isIsolated() ? "ready" : "unavailable");
  }
  return () => listeners.delete(listener);
}

/**
 * Reports whether the page can use SharedArrayBuffer, which ffmpeg.wasm and
 * onnxruntime both require for multi-threading.
 *
 * Isolation comes from real COOP/COEP headers on every target: vercel.json for
 * the web app, the app:// protocol handler for Electron, and next.config.ts
 * headers() for `next dev`. "unavailable" therefore means the browser itself
 * can't do it (insecure context, or no SharedArrayBuffer), not that we're still
 * setting up — so the UI can say so immediately instead of showing a spinner.
 */
export function useCrossOriginIsolated(): IsolationState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => "checking" as IsolationState
  );
}
