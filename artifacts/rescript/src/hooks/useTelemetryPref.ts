
import { useCallback, useState } from "react";
import { isTelemetryEnabled, setTelemetryEnabled } from "@/lib/telemetry";

/**
 * Anonymous usage telemetry preference (default on, opt-out). Safe to read in
 * the initializer because the whole editor tree is client-only (`ssr: false`).
 */
export function useTelemetryPref() {
  const [enabled, setEnabledState] = useState(() => isTelemetryEnabled());

  const setEnabled = useCallback((next: boolean) => {
    setTelemetryEnabled(next);
    setEnabledState(next);
  }, []);

  return { enabled, setEnabled };
}
