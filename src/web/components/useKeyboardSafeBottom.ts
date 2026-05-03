import { type RefObject, useEffect } from "react";

/**
 * Pin an element to the bottom of the *visual* viewport so it floats just
 * above the mobile keyboard instead of getting pushed off-screen.
 *
 * Sets `el.style.bottom` to the gap between the layout viewport and the
 * visual viewport. No-op when `visualViewport` is unavailable.
 */
export function useKeyboardSafeBottom(
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const offset = window.innerHeight - vv.offsetTop - vv.height;
      el.style.bottom = `${Math.max(0, offset)}px`;
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [ref]);
}
