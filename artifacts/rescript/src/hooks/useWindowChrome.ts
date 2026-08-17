
import { useEffect, useState, useSyncExternalStore } from "react";

export interface WindowChrome {
  /** The native title bar is hidden — the page must supply its own drag region. */
  draggable: boolean;
  /** Leave room at the top-left for the macOS traffic lights (hidden when unfocused or full screen). */
  trafficLights: boolean;
}

function subscribeFocus(onChange: () => void) {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
}

const isFocused = () => document.hasFocus();
const isFocusedOnServer = () => true;

/**
 * Describes how much window chrome the page is responsible for drawing. In a
 * browser tab this is all false; in the Electron shell on macOS the title bar
 * is hidden (see electron/main.ts) so the top bar doubles as the drag handle.
 */
export function useWindowChrome(): WindowChrome {
  const [fullScreen, setFullScreen] = useState(false);
  const focused = useSyncExternalStore(subscribeFocus, isFocused, isFocusedOnServer);

  useEffect(() => {
    const desktop = window.rescriptDesktop;
    if (!desktop) return;
    let active = true;
    // The window may already be full screen when this mounts.
    void desktop.isFullScreen().then((value) => {
      if (active) setFullScreen(value);
    });
    const unsubscribe = desktop.onFullScreenChange(setFullScreen);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Safe to read during render: every consumer lives under the client-only
  // (ssr: false) Editor, so there is no server pass to mismatch against.
  const draggable =
    typeof window !== "undefined" && window.rescriptDesktop?.platform === "darwin";

  return { draggable, trafficLights: draggable && focused && !fullScreen };
}
