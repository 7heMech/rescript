
import { isElectron } from "./platform";

/**
 * Anonymous usage telemetry — how many installs are active, and how far they get
 * through the pipeline. Deliberately not an analytics SDK and deliberately not
 * an account:
 *
 * - The only identifier is a random UUID this module generates for itself. It is
 *   not derived from the machine, the network, or the person, and clearing site
 *   data resets it.
 * - Nothing about the user's media is ever sent — no filenames, no durations, no
 *   transcript text. The `props` below are fixed vocabulary (model id, export
 *   format) chosen so that no field can carry user content.
 * - Fire-and-forget. Nothing awaits these calls, failures are swallowed, and
 *   offline is a silent no-op, so the editor behaves identically with telemetry
 *   on, off, or unreachable. That matters: the app is meant to work with the
 *   network cable pulled.
 *
 * Opt-out lives in Settings and is honoured before any of this runs.
 */

const ENDPOINT =
  import.meta.env.VITE_TELEMETRY_ENDPOINT ??
  "https://www.getrescript.com/api/telemetry";

const INSTALL_ID_KEY = "rescript.installId";
const ENABLED_KEY = "rescript.telemetry";

export type TelemetryEvent =
  | "app_opened"
  | "project_created"
  | "transcription_completed"
  | "export_completed";

type Props = Record<string, string | number | boolean>;

/** localStorage throws in private-mode Safari and when storage is full. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preference just won't persist; not worth surfacing.
  }
}

/** Opt-out, so an unset value means enabled. */
export function isTelemetryEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return read(ENABLED_KEY) !== "off";
}

/**
 * The Electron main process can't read localStorage, so it keeps its own mirror
 * of this preference on disk to gate crash reporting at startup. Push every
 * change (and the current value at boot) across the bridge.
 */
function mirrorToDesktop(enabled: boolean) {
  try {
    window.rescriptDesktop?.setTelemetryEnabled(enabled);
  } catch {
    // Older shell without the bridge method; the web build has no bridge at all.
  }
}

export function setTelemetryEnabled(enabled: boolean) {
  write(ENABLED_KEY, enabled ? "on" : "off");
  mirrorToDesktop(enabled);
}

function installId(): string | null {
  const existing = read(INSTALL_ID_KEY);
  if (existing) return existing;
  // No crypto.randomUUID on http:// origins or very old browsers. Rather than
  // fall back to a weaker id, skip reporting — a missing install is a better
  // failure than a colliding one.
  if (typeof crypto?.randomUUID !== "function") return null;
  const id = crypto.randomUUID();
  write(INSTALL_ID_KEY, id);
  // If persisting failed the id is per-session, which inflates install counts
  // slightly. Accepted: the alternative is fingerprinting.
  return id;
}

function platform(): "macos" | "windows" | "linux" | "unknown" {
  const ua = navigator.userAgent;
  if (/mac os x|macintosh/i.test(ua)) return "macos";
  if (/windows/i.test(ua)) return "windows";
  if (/linux|x11|cros/i.test(ua)) return "linux";
  return "unknown";
}

export function trackEvent(event: TelemetryEvent, props?: Props) {
  if (typeof window === "undefined") return;
  if (!isTelemetryEnabled()) return;

  const id = installId();
  if (!id) return;

  const body = JSON.stringify({
    installId: id,
    event,
    version: import.meta.env.VITE_APP_VERSION,
    platform: platform(),
    surface: isElectron ? "desktop" : "web",
    props: props ?? null,
  });

  if (import.meta.env.DEV) {
    console.debug("[telemetry]", event, props ?? {});
    return;
  }

  try {
    void fetch(ENDPOINT, {
      method: "POST",
      // Survives the export-then-close case, where the tab may go away before
      // the request settles.
      keepalive: true,
      mode: "cors",
      // No cookies, ever — this endpoint has nothing to authenticate.
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {});
  } catch {
    // Offline, blocked by an extension, or CSP — all fine, all ignored.
  }
}

/** Local calendar day — "was it used today" should mean the user's today. */
function currentDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Session-scoped, so a genuine relaunch still counts as a launch. */
let reportedDay: string | null = null;

function reportOpenedOncePerDay() {
  const day = currentDay();
  if (reportedDay === day) return;
  reportedDay = day;
  trackEvent("app_opened");
}

/** Coarse on purpose: this only has to notice a date change, not be prompt. */
const DAY_ROLLOVER_CHECK_MS = 15 * 60 * 1000;

/**
 * Reports `app_opened` now, and again if the calendar day changes while the app
 * stays open.
 *
 * Without the rollover part, a desktop app left running for a week reports one
 * launch and then looks churned — the daily-active number would undercount
 * exactly the people using it most. Both triggers are needed: `visibilitychange`
 * catches the common case of coming back to a window left open overnight, and
 * the interval catches a window that stays open *and* focused across midnight,
 * where no visibility event ever fires.
 *
 * Returns a cleanup function. Calling this twice (React Strict Mode) is
 * harmless — the second call lands on the same day and no-ops.
 */
export function startSessionReporting(): () => void {
  // Re-assert the preference each launch, so a shell whose on-disk mirror is
  // stale (or was never written) converges on the renderer's value.
  mirrorToDesktop(isTelemetryEnabled());
  reportOpenedOncePerDay();

  const onVisibility = () => {
    if (document.visibilityState === "visible") reportOpenedOncePerDay();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const timer = window.setInterval(reportOpenedOncePerDay, DAY_ROLLOVER_CHECK_MS);

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.clearInterval(timer);
  };
}
