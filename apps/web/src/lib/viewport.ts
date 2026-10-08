import { useEffect } from 'react';

const isTextEntry = (el: Element | null): boolean =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type)) ||
  (el instanceof HTMLElement && el.isContentEditable);

/** A keyboard is assumed once this much height disappears while a text field has focus. */
const KEYBOARD_MIN_PX = 100;

/**
 * Pin the app to exactly the part of the screen the player can see.
 *
 * CSS alone cannot do this on iOS: Safari does not shrink the layout viewport
 * (or `dvh`) when the keyboard opens and ignores `interactive-widget`. So the
 * visual viewport's height and offset are published as `--app-height` and
 * `--app-top` for the `.bz-app` shell, and <html> gets `kb-open` while a
 * keyboard covers part of the screen.
 */
export function useFixedViewport() {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let restHeight = 0; // visible height with no keyboard, for the current orientation
    let width = 0;
    let frame = 0;
    let settle = 0;

    const measure = () => {
      frame = 0;
      const typing = isTextEntry(document.activeElement);
      const height = vv?.height ?? window.innerHeight;
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        restHeight = 0; // rotated: forget the old orientation's height
      }
      if (!typing || height > restHeight) restHeight = height;
      const keyboard = typing && restHeight - height > KEYBOARD_MIN_PX;

      // Safari pans the visual viewport to reveal a focused field; follow it so the
      // shell stays under the player's eyes. With no keyboard the offset must be
      // zero, and it is forced there because Safari 26 can leave it stuck after the
      // keyboard closes.
      const top = keyboard ? (vv?.offsetTop ?? 0) : 0;
      if (!keyboard && ((vv?.offsetTop ?? 0) > 0 || window.scrollY > 0)) window.scrollTo(0, 0);

      root.style.setProperty('--app-height', `${height}px`);
      root.style.setProperty('--app-top', `${top}px`);
      root.classList.toggle('kb-open', keyboard);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(measure);
    };
    // The keyboard animates for a few hundred milliseconds; measure again once it has settled.
    const scheduleTwice = () => {
      schedule();
      window.clearTimeout(settle);
      settle = window.setTimeout(schedule, 350);
    };

    root.classList.add('app-fixed');
    measure();
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', scheduleTwice);
    document.addEventListener('focusin', scheduleTwice);
    document.addEventListener('focusout', scheduleTwice);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', scheduleTwice);
      document.removeEventListener('focusin', scheduleTwice);
      document.removeEventListener('focusout', scheduleTwice);
      root.classList.remove('app-fixed', 'kb-open');
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-top');
    };
  }, []);
}
