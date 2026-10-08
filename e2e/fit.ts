/**
 * "Does this phone screen fit?" — checked by measuring the live page.
 *
 * A screen fits when the page itself cannot scroll, the main area has no
 * overflow, every visible control and piece of text is inside the viewport,
 * nothing is cut off by its own box, and stacked blocks do not overlap. The
 * only exemption is content inside a `data-scroll` region (long lists).
 */
import { expect, type Page } from '@playwright/test';

/** Visible areas to test, not device sizes: several are what Safari leaves once its bars are showing. */
const PHONE_SIZES: [name: string, width: number, height: number][] = [
  ['tiny, browser bars', 320, 480],
  ['iPhone SE, browser bars', 375, 553],
  ['iPhone SE, full', 375, 667],
  ['iPhone 15, browser bars', 393, 659],
  ['iPhone 15, home-screen app', 393, 852],
  ['Pro Max', 440, 956],
  ['Android', 360, 640],
  ['landscape SE', 667, 331],
  ['landscape iPhone 15', 852, 340],
];

/** What is left above an on-screen keyboard. */
const KEYBOARD_SIZES: [name: string, width: number, height: number][] = [
  ['iPhone SE + keyboard', 375, 300],
  ['iPhone 15 + keyboard', 393, 400],
  ['Android + keyboard', 360, 330],
];

function measure(): string[] {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const problems: string[] = [];
  const name = (el: Element) => {
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
    return `<${el.tagName.toLowerCase()}${cls}>${text ? ` "${text}"` : ''}`;
  };
  const visible = (el: Element) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  };

  const page = document.scrollingElement!;
  if (page.scrollHeight > H + 1 || page.scrollWidth > W + 1) problems.push(`the page scrolls: ${page.scrollWidth}×${page.scrollHeight} in ${W}×${H}`);

  const shell = document.querySelector('.bz-app');
  if (!shell) return ['no app shell on this screen'];
  const box = shell.getBoundingClientRect();
  if (Math.abs(box.height - H) > 1 || Math.abs(box.top) > 1) problems.push(`shell is ${Math.round(box.height)}px tall at y=${Math.round(box.top)}, viewport is ${H}px`);

  // The main area's own scrolling is a last resort that no supported size should need.
  for (const el of shell.querySelectorAll('.play__main, .home__body')) {
    if (el.scrollHeight > el.clientHeight + 1) problems.push(`${name(el)} overflows by ${el.scrollHeight - el.clientHeight}px`);
  }

  // Everything visible must be on screen, unless it lives in a region that is allowed to scroll.
  for (const el of shell.querySelectorAll('button, input, a, h1, h2, p, li, label, [data-scroll], .bz-num, .bz-timer, .bz-avatar')) {
    if (!visible(el)) continue;
    const scroller = el.parentElement?.closest('[data-scroll]');
    if (scroller) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.top < -1 || r.left < -1 || r.right > W + 1 || r.bottom > H + 1) {
      problems.push(`${name(el)} is off screen (${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)})`);
    }
  }

  // Nothing cut off by its own box.
  for (const el of shell.querySelectorAll('h1, h2, p, button, section, form, header')) {
    if (!visible(el) || el.hasAttribute('data-scroll')) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis' || cs.overflowY === 'visible') continue;
    if (el.scrollHeight > el.clientHeight + 2) problems.push(`${name(el)} is clipped by ${el.scrollHeight - el.clientHeight}px`);
  }

  // A box must contain its own contents: nothing may spill out over whatever comes next.
  for (const el of shell.querySelectorAll('.play__panel, .play__clue, .play__stage, .play__center, .play__buzz, .home__card, .home__who')) {
    if (!visible(el) || el.hasAttribute('data-scroll')) continue;
    if (el.scrollHeight > el.clientHeight + 1) problems.push(`${name(el)} is ${el.scrollHeight - el.clientHeight}px too short for its contents`);
  }

  // Blocks stacked in a column must not run into each other.
  for (const parent of shell.querySelectorAll('.play__main, .play__panel, .play__stage, .play__clue, .play__center, .play__buzz, .home, .home__body, .home__card, .home__who')) {
    const kids = [...parent.children].filter((k) => visible(k) && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed');
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i].getBoundingClientRect();
      const b = kids[i + 1].getBoundingClientRect();
      const sideBySide = a.right <= b.left + 1 || b.right <= a.left + 1;
      if (!sideBySide && a.bottom > b.top + 1.5) problems.push(`${name(kids[i])} overlaps ${name(kids[i + 1])} by ${Math.round(a.bottom - b.top)}px`);
    }
  }

  // Things you tap must be big enough to hit. (Question dots are a secondary shortcut and may be smaller.)
  for (const el of shell.querySelectorAll('button, input:not([type=range])')) {
    if (!visible(el) || el.closest('.play__dots')) continue;
    const r = el.getBoundingClientRect();
    if (r.width && (r.height < 28 || r.width < 28)) problems.push(`${name(el)} is a small target: ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  return problems;
}

async function settle(page: Page) {
  // Two frames for the viewport hook and layout, then let entrance animations finish:
  // a panel that is still sliding into place would be measured where it is not going to stay.
  await page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null))));
    const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
  await page.waitForTimeout(40);
}

/** Resize the phone through every size in `sizes` and assert the current screen fits each one. */
export async function expectFits(page: Page, label: string, sizes = PHONE_SIZES, shotDir?: string) {
  const original = page.viewportSize()!;
  const failures: string[] = [];
  for (const [name, width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await settle(page);
    for (const problem of await page.evaluate(measure)) failures.push(`[${label} @ ${name} ${width}×${height}] ${problem}`);
    if (shotDir) await page.screenshot({ path: `${shotDir}/${label}--${width}x${height}.png` });
  }
  await page.setViewportSize(original);
  await settle(page);
  expect(failures).toEqual([]);
}

/**
 * Check a screen with a text field focused and the visible area cut down to
 * what a keyboard leaves. Shrinking the viewport is how Android behaves; on
 * iOS the same code reads the shrunken visual viewport instead.
 */
export async function expectFitsWithKeyboard(page: Page, label: string, field: string, mustSee: string[], shotDir?: string) {
  const original = page.viewportSize()!;
  await page.locator(field).first().focus();
  const failures: string[] = [];
  for (const [name, width, height] of KEYBOARD_SIZES) {
    // Start from the keyboard-closed size for this device so the app can see the height drop.
    await page.setViewportSize({ width, height: height + 300 });
    await settle(page);
    await page.setViewportSize({ width, height });
    await settle(page);
    const state = await page.evaluate(() => ({ keyboard: document.documentElement.classList.contains('kb-open'), typing: document.activeElement?.tagName }));
    if (!state.keyboard) failures.push(`[${label} @ ${name}] keyboard was not detected (focus is on ${state.typing})`);
    for (const problem of await page.evaluate(measure)) failures.push(`[${label} @ ${name} ${width}×${height}] ${problem}`);
    for (const selector of [field, ...mustSee]) {
      if (!(await page.locator(selector).first().isVisible())) failures.push(`[${label} @ ${name}] ${selector} is not visible above the keyboard`);
    }
    if (shotDir) await page.screenshot({ path: `${shotDir}/${label}--keyboard-${width}x${height}.png` });
  }
  await page.setViewportSize(original);
  await settle(page);
  expect(failures).toEqual([]);
}
