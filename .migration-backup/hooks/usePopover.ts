"use client";

import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type Placement,
  type UseFloatingReturn,
} from "@floating-ui/react";

type PopoverPosition = {
  /** Callback ref for the trigger / anchor element. */
  setReference: UseFloatingReturn["refs"]["setReference"];
  /** Callback ref for the floating panel. */
  setFloating: UseFloatingReturn["refs"]["setFloating"];
  floatingStyles: UseFloatingReturn["floatingStyles"];
  /** Raw Floating UI refs (for outside-click checks in effects). */
  refs: UseFloatingReturn["refs"];
};

/**
 * Collision-aware anchoring for popover panels.
 *
 * Keeps current visuals (caller owns className / width / chrome) while
 * replacing hard-coded absolute offsets with Floating UI flip + shift so
 * menus stay in the viewport on mobile.
 */
export function usePopover({
  open,
  placement = "bottom-end",
  /** Main-axis gap in px. 8 matches former `top-[calc(100%+0.5rem)]`. */
  offsetMain = 8,
  padding = 8,
}: {
  open: boolean;
  placement?: Placement;
  offsetMain?: number;
  padding?: number;
}): PopoverPosition {
  const { refs, floatingStyles } = useFloating({
    open,
    placement,
    strategy: "fixed",
    // Use top/left instead of transform so nested fixed flyouts (e.g. the
    // language submenu) are still positioned against the viewport, not trapped
    // by a transformed ancestor.
    transform: false,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(offsetMain),
      flip({ padding }),
      shift({ padding }),
    ],
  });

  // Destructure callback refs so JSX can use them without tripping the
  // react-hooks/refs false positive on `refs.setFloating` property access.
  const { setReference, setFloating } = refs;

  return { setReference, setFloating, floatingStyles, refs };
}
