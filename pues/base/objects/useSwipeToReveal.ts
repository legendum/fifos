/**
 * `useSwipeToReveal` — pointer + touch swipe-to-reveal gesture on a row,
 * lifted as-is from the byte-identical copies that lived in
 * `todos/src/web/components/useSwipeToReveal.ts` and the matching fifos
 * file. Pure mechanism: returns offset/handlers/reset/handleClick — the
 * consumer renders whatever action buttons live in the revealed area.
 *
 * Wiring (consumer side):
 * - Spread `slideHandlers` onto the sliding row (the layer that
 *   translates).
 * - Apply `sliderStyle` to that same element.
 * - Render action buttons (Edit, Delete, Copy, …) behind the row; size
 *   them in CSS to match `BUTTON_WIDTH * actionCount` and the
 *   `.row-edit` / `.row-delete` class names this hook detects in
 *   `onPointerDown` (so taps on the buttons don't start a drag).
 * - Call `handleClick(onSelect)` from the row's `onClick` — it skips
 *   when the gesture was a swipe and closes when the row is already
 *   open.
 */

import { useCallback, useRef, useState } from "react";

const BUTTON_WIDTH = 72;
/** Pointer must move this far before we commit to a gesture direction. */
const DIRECTION_THRESHOLD = 6;

export type SwipeToRevealResult = {
  sliderStyle: React.CSSProperties;
  reset: () => void;
  /** Call from the row's native `onClick`. Runs `onSelect` only when the
   * gesture was a real tap (not a swipe) and the row isn't already open. */
  handleClick: (onSelect: () => void) => void;
  slideHandlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
};

type GestureMode = "pending" | "horizontal" | "vertical";

/**
 * Selectors that, when the pointerdown target sits inside one, skip the
 * gesture entirely (the pointer is interacting with a non-row affordance
 * — action button, drag handle, etc.). The default list covers what
 * pues itself implies: the revealed action buttons and the dnd-kit
 * drag handle. Consumers extend it with their own row-internal
 * affordances (todos: checkbox + inline links; fifos: similar; …).
 */
const DEFAULT_IGNORE_SELECTORS = [
  "button.row-edit",
  "button.row-delete",
  ".drag-handle",
];

export type UseSwipeToRevealOptions = {
  actionCount?: number;
  /** Selectors layered on top of `DEFAULT_IGNORE_SELECTORS`. A pointerdown
   * whose target sits inside any of them is treated as a non-drag. */
  ignoreSelectors?: string[];
};

export function useSwipeToReveal(
  options: UseSwipeToRevealOptions = {},
): SwipeToRevealResult {
  const { actionCount = 1, ignoreSelectors } = options;
  const actionsWidth = BUTTON_WIDTH * actionCount;
  const allIgnoreSelectors = ignoreSelectors
    ? [...DEFAULT_IGNORE_SELECTORS, ...ignoreSelectors]
    : DEFAULT_IGNORE_SELECTORS;
  const snapThreshold = actionsWidth / 2;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const mode = useRef<GestureMode>("pending");
  const swiped = useRef(false);
  const dragStart = useRef<{
    x: number;
    y: number;
    offset: number;
    pointerId: number;
  } | null>(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const onPointerUp = useCallback(() => {
    if (dragStart.current == null) return;
    const snapOpen = offsetRef.current < -snapThreshold;
    if (mode.current === "horizontal") {
      setOffset(snapOpen ? -actionsWidth : 0);
      swiped.current = true;
    }
    dragStart.current = null;
    mode.current = "pending";
    setDragging(false);
  }, [actionsWidth, snapThreshold]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      mode.current = "pending";
      swiped.current = false;
      const target = e.target as HTMLElement;
      for (const selector of allIgnoreSelectors) {
        if (target.closest?.(selector)) return;
      }
      if (e.pointerType === "mouse") e.preventDefault();
      dragStart.current = {
        x: e.clientX,
        y: e.clientY,
        offset: offsetRef.current,
        pointerId: e.pointerId,
      };
      setDragging(true);
    },
    [allIgnoreSelectors],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragStart.current == null) return;
      if (e.pointerType === "mouse" && e.buttons !== 1) {
        onPointerUp();
        return;
      }
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;

      if (mode.current === "pending") {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax < DIRECTION_THRESHOLD && ay < DIRECTION_THRESHOLD) return;
        if (ay > ax) {
          mode.current = "vertical";
          dragStart.current = null;
          setDragging(false);
          return;
        }
        mode.current = "horizontal";
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(
            dragStart.current.pointerId,
          );
        } catch {}
      }

      if (mode.current !== "horizontal") return;
      const next = Math.max(
        -actionsWidth,
        Math.min(0, dragStart.current.offset + dx),
      );
      setOffset(next);
    },
    [onPointerUp, actionsWidth],
  );

  const sliderStyle: React.CSSProperties = {
    transform: `translateX(${offset}px)`,
    transition: dragging ? "none" : "transform 0.15s ease-out",
  };

  const reset = useCallback(() => setOffset(0), []);

  const handleClick = useCallback((onSelect: () => void) => {
    // Browser fired a compat click after our pointer sequence.
    // Skip if it was actually a swipe, or if the row is revealed
    // (then close instead of opening).
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    if (offsetRef.current !== 0) {
      setOffset(0);
      return;
    }
    onSelect();
  }, []);

  return {
    sliderStyle,
    reset,
    handleClick,
    slideHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

/**
 * Pure helpers — exported for testability. The hook above bakes these
 * into its closure; consumers don't need them directly.
 */

export function clampSwipeOffset(
  startOffset: number,
  dx: number,
  actionsWidth: number,
): number {
  return Math.max(-actionsWidth, Math.min(0, startOffset + dx));
}

export function shouldSnapOpen(offset: number, actionsWidth: number): boolean {
  return offset < -(actionsWidth / 2);
}

export function detectGestureMode(
  dx: number,
  dy: number,
  threshold = DIRECTION_THRESHOLD,
): GestureMode {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < threshold && ay < threshold) return "pending";
  return ay > ax ? "vertical" : "horizontal";
}
