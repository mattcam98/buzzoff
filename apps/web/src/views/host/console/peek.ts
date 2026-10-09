import { useState, type FocusEvent, type MouseEvent, type PointerEvent } from 'react';

/**
 * Hold to read. A category's description is shown for as long as its title is
 * held, with the mouse or a finger, and while it has the keyboard's focus.
 * `holdable(i)` is what makes item `i` respond; `peek` is the one being held.
 */
export function usePeek() {
  const [peek, setPeek] = useState<number | null>(null);
  const close = () => setPeek(null);
  const holdable = (i: number) => ({
    'data-peek': peek === i ? 'open' : '',
    tabIndex: 0,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      // Captured, so letting go anywhere closes it.
      e.currentTarget.setPointerCapture(e.pointerId);
      setPeek(i);
    },
    onPointerUp: close,
    onPointerCancel: close,
    onLostPointerCapture: close,
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) setPeek(i);
    },
    onBlur: close,
  });
  return { peek, holdable };
}
