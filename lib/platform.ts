export const isElectron =
  typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent);
