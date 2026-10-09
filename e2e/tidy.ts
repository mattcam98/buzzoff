import { test } from '@playwright/test';

/**
 * Close every browser context a test opened. Playwright closes the ones it makes itself, but these
 * tests open their own (a host, a TV, a handful of phones), and a page left open keeps playing in
 * the background: timers, music, a socket. Every test after it then runs that much slower.
 */
export function closePagesAfterEachTest() {
  test.afterEach(async ({ browser }) => {
    await Promise.all(browser.contexts().map((context) => context.close()));
  });
}
