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

export function useSwipeToReveal(
  options: { actionCount?: number } = {},
): SwipeToRevealResult {
  const { actionCount = 1 } = options;
  const actionsWidth = BUTTON_WIDTH * actionCount;
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

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    mode.current = "pending";
    swiped.current = false;
    const target = e.target as HTMLElement;
    if (
      target.closest?.("button.row-delete") ||
      target.closest?.("button.row-edit")
    )
      return;
    if (target.closest?.(".drag-handle")) return;
    if (target.closest?.(".todo-checkbox")) return;
    if (target.closest?.("a.text-inline-link")) return;
    if (e.pointerType === "mouse") e.preventDefault();
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      offset: offsetRef.current,
      pointerId: e.pointerId,
    };
    setDragging(true);
  }, []);

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
    [onPointerUp],
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
