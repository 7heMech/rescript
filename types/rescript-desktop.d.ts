/** Resting sizes the Electron shell switches between. */
export type WindowMode = "compact" | "expanded";

/** Desktop bridge exposed by electron/preload.ts when running inside Electron. */
export interface RescriptDesktop {
  platform: NodeJS.Platform;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  /** Resize the shell: "compact" for the upload screen, "expanded" for the editor. */
  setWindowMode: (mode: WindowMode) => void;
  isFullScreen: () => Promise<boolean>;
  /** Subscribe to full-screen changes; returns an unsubscribe function. */
  onFullScreenChange: (callback: (value: boolean) => void) => () => void;
}

declare global {
  interface Window {
    rescriptDesktop?: RescriptDesktop;
  }
}

export {};
