import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Sentry from "@sentry/electron/main";

/**
 * Crash reporting for the Electron main process — the updater, the app://
 * protocol handler, and window management. Failures there are the ones the
 * renderer can never tell us about, because they stop the window existing.
 *
 * The opt-out lives in renderer localStorage, which this process cannot read, so
 * the preference is mirrored to disk (see `electron/preload.ts` →
 * `telemetry:set-enabled`). That mirror is what makes early-startup gating
 * possible at all: by the time the renderer could tell us, the crash we most
 * want is already over.
 *
 * Three defaults are switched off deliberately:
 *
 * - **SentryMinidump** — native minidumps embed process memory. A renderer crash
 *   dump would carry decoded audio and transcript text, which is exactly what
 *   the app promises never to upload. This is the one integration that could
 *   turn a crash report into a media leak, so it stays off even though it costs
 *   us native crash visibility.
 * - **LocalVariables** — attaches local variable values to frames. In this
 *   process those are mostly filesystem paths, and it's a wide surface to have
 *   to keep scrubbing.
 * - **attachScreenshot** — left at its default of `false`. A screenshot of this
 *   app is a screenshot of someone's transcript.
 */

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
const PREF_FILE = "telemetry.json";

/**
 * Absolute paths leak the OS account name. The home directory is replaced
 * outright; any other user-rooted path keeps its shape so the directory is still
 * legible, with only the account segment removed.
 */
const HOME = homedir();
const USER_DIR_RE = /((?:\/Users|\/home|[A-Za-z]:\\Users)[/\\])[^/\\\s"']+/g;

export function scrubPaths(input: string): string {
  const withoutHome = HOME ? input.split(HOME).join("<home>") : input;
  return withoutHome.replace(USER_DIR_RE, "$1<user>");
}

function prefPath(): string {
  return join(app.getPath("userData"), PREF_FILE);
}

/** Opt-out, so an unreadable or absent file means enabled — matching the renderer. */
function loadPreference(): boolean {
  try {
    const raw = readFileSync(prefPath(), "utf8");
    return (JSON.parse(raw) as { enabled?: boolean }).enabled !== false;
  } catch {
    return true;
  }
}

function savePreference(enabled: boolean) {
  try {
    writeFileSync(prefPath(), JSON.stringify({ enabled }), "utf8");
  } catch {
    // Non-fatal: the renderer stays the source of truth and will tell us again
    // next launch. Worst case main-process reporting lags a session behind.
  }
}

let enabled = false;
let initialised = false;

function ensureInitialised() {
  if (initialised || !DSN) return;
  initialised = true;

  Sentry.init({
    dsn: DSN,
    release: app.getVersion(),
    environment: app.isPackaged ? "production" : "development",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    integrations: (defaults) =>
      defaults.filter(
        (integration) =>
          !["SentryMinidump", "LocalVariables", "Screenshots"].includes(
            integration.name
          )
      ),

    beforeBreadcrumb(breadcrumb) {
      if (!enabled) return null;
      if (breadcrumb.message) breadcrumb.message = scrubPaths(breadcrumb.message);
      return breadcrumb;
    },

    // Checked here rather than by tearing the client down, so toggling the
    // preference mid-session takes effect immediately in both directions.
    beforeSend(event) {
      if (!enabled) return null;
      for (const value of event.exception?.values ?? []) {
        if (value.value) value.value = scrubPaths(value.value);
        for (const frame of value.stacktrace?.frames ?? []) {
          if (frame.filename) frame.filename = scrubPaths(frame.filename);
          if (frame.abs_path) frame.abs_path = scrubPaths(frame.abs_path);
        }
      }
      if (event.message) event.message = scrubPaths(event.message);
      return event;
    },
  });
}

/** Call as early as possible in main, before the app is ready. */
export function initMainSentry() {
  enabled = loadPreference();
  if (enabled) ensureInitialised();
}

/** Driven by the renderer whenever the Settings toggle changes, and at boot. */
export function setMainTelemetryEnabled(next: boolean) {
  if (next === enabled) return;
  enabled = next;
  savePreference(next);
  if (next) ensureInitialised();
}
