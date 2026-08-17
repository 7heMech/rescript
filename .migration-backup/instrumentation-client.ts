import { initSentry } from "@/lib/sentry";

// Runs before the app becomes interactive, so crashes during the editor's first
// render are captured too. Guarded because instrumentation failing must never be
// the reason the app fails to start.
try {
  initSentry();
} catch {
  // Nothing useful to do here — the reporter is the thing that's broken.
}
