
import {
  cloneElement,
  createContext,
  useContext,
  useEffect,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  FloatingPortal,
  type Placement,
  type UseFloatingReturn,
} from "@floating-ui/react";
import { usePopover } from "@/hooks/usePopover";
import PopupDismissBackdrop from "./PopupDismissBackdrop";

type PopoverContextValue = {
  open: boolean;
  setReference: UseFloatingReturn["refs"]["setReference"];
  setFloating: UseFloatingReturn["refs"]["setFloating"];
  floatingStyles: CSSProperties;
  portal: boolean;
};

const PopoverContext = createContext<PopoverContextValue | null>(null);

function usePopoverCtx(): PopoverContextValue {
  const ctx = useContext(PopoverContext);
  if (!ctx) {
    throw new Error("Popover components must be used within <Popover>");
  }
  return ctx;
}

function cx(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(" ");
}

/** Shared panel chrome used by menus in the app. */
export const POPOVER_PANEL =
  "rounded-xl border border-zinc-200 bg-white shadow-lg shadow-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/40";

type PopoverProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placement?: Placement;
  /** Main-axis gap in px. Default 8. */
  offsetMain?: number;
  padding?: number;
  /** Portal content to document.body. Default true. */
  portal?: boolean;
  /**
   * Full-screen dismiss catcher for Electron drag regions (and a reliable
   * outside-press target on web). Rendered in a portal under the panel.
   * Default false.
   */
  backdrop?: boolean;
  /** Stacking class for the portaled backdrop; keep below PopoverContent. */
  backdropZClassName?: string;
  /** Stop Escape from bubbling (nested flyouts). Default false. */
  escapeStopPropagation?: boolean;
  children: ReactNode;
};

/**
 * Collision-aware popover shell. Positioning/dismiss/portal only — callers
 * own trigger and panel visuals.
 *
 * @example
 * ```tsx
 * <Popover open={open} onOpenChange={setOpen} backdrop>
 *   <div className="relative z-30 shrink-0">
 *     <PopoverTrigger>
 *       <button type="button">Open</button>
 *     </PopoverTrigger>
 *     <PopoverContent className="z-40 w-60" role="dialog">
 *       …
 *     </PopoverContent>
 *   </div>
 * </Popover>
 * ```
 */
export default function Popover({
  open,
  onOpenChange,
  placement = "bottom-end",
  offsetMain = 8,
  padding = 8,
  portal = true,
  backdrop = false,
  backdropZClassName = "z-20",
  escapeStopPropagation = false,
  children,
}: PopoverProps) {
  const { refs, setReference, setFloating, floatingStyles } = usePopover({
    open,
    placement,
    offsetMain,
    padding,
  });

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (refs.domReference.current?.contains(target)) return;
      if (refs.floating.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escapeStopPropagation) e.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener(
      "keydown",
      onKey,
      escapeStopPropagation ? true : undefined
    );
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener(
        "keydown",
        onKey,
        escapeStopPropagation ? true : undefined
      );
    };
  }, [open, onOpenChange, refs, escapeStopPropagation]);

  // Portal the backdrop with the panel so both share the same stacking root
  // (document.body). An in-tree fixed backdrop can end up above the portaled
  // panel when an ancestor creates a stacking context — clicks then hit the
  // dismiss layer instead of links / controls inside the menu.
  const backdropNode =
    backdrop && open ? (
      <PopupDismissBackdrop
        onDismiss={() => onOpenChange(false)}
        zClassName={backdropZClassName}
      />
    ) : null;

  return (
    <PopoverContext.Provider
      value={{ open, setReference, setFloating, floatingStyles, portal }}
    >
      {backdropNode &&
        (portal ? <FloatingPortal>{backdropNode}</FloatingPortal> : backdropNode)}
      {children}
    </PopoverContext.Provider>
  );
}

/**
 * Attaches the positioning reference ref to a single child element
 * (typically the trigger button).
 */
export function PopoverTrigger({
  children,
}: {
  children: ReactElement<{ ref?: Ref<HTMLElement | null> }>;
}) {
  const { setReference } = usePopoverCtx();
  return cloneElement(children, { ref: setReference });
}

type PopoverContentProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** When false, skip the shared panel chrome classes. Default true. */
  panelChrome?: boolean;
};

/**
 * Floating panel. Stays mounted when closed (`display: none`) so stateful
 * children (e.g. registered option triggers) keep working.
 */
export function PopoverContent({
  children,
  className,
  panelChrome = true,
  style,
  hidden,
  ...rest
}: PopoverContentProps) {
  const { open, setFloating, floatingStyles, portal } = usePopoverCtx();

  const panel = (
    <div
      ref={setFloating}
      hidden={hidden ?? !open}
      className={cx(
        panelChrome && POPOVER_PANEL,
        className,
        open ? undefined : "pointer-events-none"
      )}
      style={
        open
          ? { ...floatingStyles, ...style }
          : { ...floatingStyles, ...style, display: "none" }
      }
      {...rest}
    >
      {children}
    </div>
  );

  return portal ? <FloatingPortal>{panel}</FloatingPortal> : panel;
}
