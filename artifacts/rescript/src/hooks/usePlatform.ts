
import { useSyncExternalStore } from "react";
import { detectPlatform, type Platform } from "@/lib/platform";

// The OS never changes mid-session, so there is nothing to subscribe to.
const subscribe = () => () => {};
const getServerSnapshot = (): Platform => "unknown";

/**
 * Reads the visitor's platform without a hydration mismatch: the server (and
 * the hydrating client render) sees "unknown", then React swaps in the real
 * value. `detectPlatform` returns a string, so the snapshot is stable by value.
 */
export function usePlatform(): Platform {
  return useSyncExternalStore(subscribe, detectPlatform, getServerSnapshot);
}
