/**
 * Full-screen click catcher for open popovers.
 *
 * Electron title-bar drag regions (`-webkit-app-region: drag`) do not deliver
 * pointer events to the page, so a document-level "click outside" listener never
 * sees presses on the TopBar drag strip. This layer opts out of dragging and
 * closes the popover instead.
 */
export default function PopupDismissBackdrop({
  onDismiss,
  /** Stacking order; the popover root should sit above this. */
  zClassName = "z-20",
}: {
  onDismiss: () => void;
  zClassName?: string;
}) {
  return (
    <div
      className={`app-no-drag fixed inset-0 ${zClassName}`}
      aria-hidden
      onPointerDown={onDismiss}
    />
  );
}
