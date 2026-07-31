"use client";

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
import { useAnchoredPopover } from "@/hooks/useAnchoredPopover";
import PopupDismissBackdrop from "./PopupDismissBackdrop";

type AnchoredPopoverContextValue = {
  open: boolean;
  setReference: UseFloatingReturn["refs"]["setReference"];
  setFloating: UseFloatingReturn["refs"]["setFloating"];
  floatingStyles: CSSProperties;
  portal: boolean;
};

const AnchoredPopoverContext =
  createContext<AnchoredPopoverContextValue | null>(null);

function useAnchoredPopoverCtx(): AnchoredPopoverContextValue {
  const ctx = useContext(AnchoredPopoverContext);
  if (!ctx) {
    throw new Error(
      "AnchoredPopover components must be used within <AnchoredPopover>"
    );
  }
  return ctx;
}

function cx(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(" ");
}

/** Shared panel chrome used by menus in the app. */
export const ANCHORED_POPOVER_PANEL =
  "rounded-xl border border-zinc-200 bg-white shadow-lg shadow-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/40";

type AnchoredPopoverProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placement?: Placement;
  /** Main-axis gap in px. Default 8. */
  offsetMain?: number;
  padding?: number;
  /** Portal content to document.body. Default true. */
  portal?: boolean;
  /** Full-screen dismiss catcher for Electron drag regions. Default false. */
  backdrop?: boolean;
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
 * <AnchoredPopover open={open} onOpenChange={setOpen} backdrop>
 *   <div className="relative z-30 shrink-0">
 *     <AnchoredPopoverTrigger>
 *       <button type="button">Open</button>
 *     </AnchoredPopoverTrigger>
 *     <AnchoredPopoverContent className="z-40 w-60" role="dialog">
 *       …
 *     </AnchoredPopoverContent>
 *   </div>
 * </AnchoredPopover>
 * ```
 */
export default function AnchoredPopover({
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
}: AnchoredPopoverProps) {
  const { refs, setReference, setFloating, floatingStyles } =
    useAnchoredPopover({ open, placement, offsetMain, padding });

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

  return (
    <AnchoredPopoverContext.Provider
      value={{ open, setReference, setFloating, floatingStyles, portal }}
    >
      {backdrop && open && (
        <PopupDismissBackdrop
          onDismiss={() => onOpenChange(false)}
          zClassName={backdropZClassName}
        />
      )}
      {children}
    </AnchoredPopoverContext.Provider>
  );
}

/**
 * Attaches the positioning reference ref to a single child element
 * (typically the trigger button).
 */
export function AnchoredPopoverTrigger({
  children,
}: {
  children: ReactElement<{ ref?: Ref<HTMLElement | null> }>;
}) {
  const { setReference } = useAnchoredPopoverCtx();
  return cloneElement(children, { ref: setReference });
}

type AnchoredPopoverContentProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  /** When false, skip the shared panel chrome classes. Default true. */
  panelChrome?: boolean;
};

/**
 * Floating panel. Stays mounted when closed (`display: none`) so stateful
 * children (e.g. registered option triggers) keep working.
 */
export function AnchoredPopoverContent({
  children,
  className,
  panelChrome = true,
  style,
  hidden,
  ...rest
}: AnchoredPopoverContentProps) {
  const { open, setFloating, floatingStyles, portal } = useAnchoredPopoverCtx();

  const panel = (
    <div
      ref={setFloating}
      hidden={hidden ?? !open}
      className={cx(
        panelChrome && ANCHORED_POPOVER_PANEL,
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
