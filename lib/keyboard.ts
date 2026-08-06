/**
 * True when a keystroke belongs to a text field rather than the global
 * shortcuts. File inputs are excluded on purpose: the desktop File › Open
 * Project… menu and the transcript Import label both click a hidden
 * `<input type="file">`, which keeps focus after the picker closes — treating
 * that as "typing" silently killed the spacebar play/pause hotkey.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && (el as HTMLInputElement).type !== "file";
}
