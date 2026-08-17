
import {
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
  type Placement,
} from "@floating-ui/react";
import { useLayoutEffect, type RefObject } from "react";

/** Union the viewport boxes of the given word spans inside `container`. */
export function unionWordRects(
  container: HTMLElement,
  wordIds: number[]
): DOMRect {
  let top = Infinity;
  let left = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;
  let found = false;

  for (const id of wordIds) {
    const el = container.querySelector(`[data-wid="${id}"]`);
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    bottom = Math.max(bottom, r.bottom);
    right = Math.max(right, r.right);
    found = true;
  }

  if (!found) return new DOMRect();
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * Fixed, portaled anchoring against a live union of transcript word spans.
 * Escapes overflow clipping on the transcript pane (and other workspace
 * sections) the same way app menus do via Floating UI.
 */
export function useWordAnchorFloating({
  open,
  wordIds,
  containerRef,
  placement = "top",
  offsetMain = 8,
  padding = 8,
}: {
  open: boolean;
  wordIds: number[] | null | undefined;
  containerRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  offsetMain?: number;
  padding?: number;
}) {
  const { refs, floatingStyles } = useFloating({
    open,
    placement,
    strategy: "fixed",
    // Match usePopover: top/left positioning so nested fixed UI isn't trapped
    // by a transformed ancestor.
    transform: false,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(offsetMain),
      flip({ padding }),
      shift({ padding }),
    ],
  });

  const { setFloating, setPositionReference } = refs;
  // Primitive dep so a new number[] with the same ids doesn't reset the anchor.
  const idsKey = wordIds?.join(",") ?? "";

  useLayoutEffect(() => {
    if (!open || !wordIds?.length) return;
    const container = containerRef.current;
    if (!container) return;
    const ids = wordIds;

    setPositionReference({
      contextElement: container,
      getBoundingClientRect: () => unionWordRects(container, ids),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey stands in for wordIds
  }, [open, idsKey, containerRef, setPositionReference]);

  return { setFloating, floatingStyles };
}
