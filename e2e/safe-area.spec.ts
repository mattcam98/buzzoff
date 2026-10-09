/**
 * Every page, as an iPhone shows it once BuzzOff is on the Home Screen: the page runs under the
 * status bar and the home indicator, and beside the notch in landscape. Nothing readable or
 * tappable may sit in those parts of the screen, and no pinned bar may cover another.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { closePagesAfterEachTest } from './tidy';

closePagesAfterEachTest();

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
const MODES: Record<string, { viewport: { width: number; height: number }; insets: Insets }> = {
  upright: { viewport: { width: 402, height: 874 }, insets: { top: 62, right: 0, bottom: 34, left: 0 } },
  sideways: { viewport: { width: 874, height: 402 }, insets: { top: 0, right: 62, bottom: 21, left: 62 } },
  // The narrowest phone still sold: the bars have to hold everything here too.
  small: { viewport: { width: 360, height: 640 }, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
};

/** Runs in the page. Lists what is in a reserved part of the screen, as text a failure can show. */
function faults(insets: Insets): string[] {
  const W = innerWidth;
  const H = innerHeight;
  const pinned = (el: Element) => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) if (['fixed', 'sticky'].includes(getComputedStyle(e).position)) return true;
    return false;
  };
  // A strip that scrolls sideways is meant to run off the edge.
  const inStrip = (el: Element) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX)) return true;
    return false;
  };
  const found = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>('a, button, input, select, textarea, h1, h2, h3, p, strong, label, li, span, b, small, dt, dd, summary')) {
    if (el.closest('.sr-only, [aria-hidden="true"]')) continue;
    const control = el.matches('a, button, input, select, textarea');
    const text = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent?.trim()).join(' ').trim();
    if (!control && !text) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= H || r.right <= 0 || r.left >= W) continue;
    const where: string[] = [];
    // What scrolls with the page may pass under the status bar; what is there at rest, or pinned, may not be.
    if ((scrollY === 0 || pinned(el)) && r.top < insets.top - 0.5) where.push('under the status bar');
    if (pinned(el) && r.bottom > H - insets.bottom + 0.5) where.push('under the home indicator');
    if (!inStrip(el) && (r.left < insets.left - 0.5 || r.right > W - insets.right + 0.5)) where.push('off the side');
    if (where.length) found.add(`<${el.tagName.toLowerCase()} class="${el.className}"> “${(text || el.getAttribute('aria-label') || '').slice(0, 30)}” is ${where.join(' and ')}`);
  }
  const bars = [...document.querySelectorAll<HTMLElement>('*')].filter((e) => {
    const h = e.getBoundingClientRect().height;
    return ['fixed', 'sticky'].includes(getComputedStyle(e).position) && h > 20 && h < H / 2 && !e.closest('.bz-toasts');
  });
  for (const a of bars) {
    for (const b of bars) {
      if (a === b || a.contains(b) || b.contains(a)) continue;
      const [x, y] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
      if (x.top < y.top && x.bottom > y.top + 1 && x.left < y.right && y.left < x.right) found.add(`.${a.className.split(' ')[0]} covers .${b.className.split(' ')[0]}`);
    }
  }
  if (document.documentElement.scrollWidth > W) found.add('the page scrolls sideways');
  return [...found];
}

for (const [mode, { viewport, insets }] of Object.entries(MODES)) {
  test(`nothing sits under the status bar, the notch or the home indicator (${mode})`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const open = async () => {
      const page = await context.newPage();
      await (await context.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride', { insets });
      return page;
    };
    const problems: string[] = [];
    /** Check a screen at rest and again part-way down, where only the pinned bars are still at the edges. */
    const check = async (page: Page, name: string) => {
      const settle = () => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
      await settle();
      for (const offset of [0, 260]) {
        await page.evaluate((y) => window.scrollTo(0, y), offset);
        await settle();
        for (const fault of await page.evaluate(faults, insets)) problems.push(`${name}${offset ? ' (scrolled)' : ''}: ${fault}`);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    };

    const host = await open();
    await host.goto('/host/new');
    await expect(host.getByRole('button', { name: /^Create/ })).toBeVisible();
    await check(host, 'new game');
    await host.getByRole('button', { name: /^Create/ }).click();
    await expect(host.getByRole('heading', { name: 'Waiting for players' })).toBeVisible();
    const code = host.url().slice(-4);
    await check(host, 'console, lobby');

    const phone = await open();
    await phone.goto('/');
    await expect(phone.locator('.home__code input')).toBeVisible();
    await check(phone, 'join, code');
    await phone.goto(`/join/${code}`);
    await phone.getByLabel('Your name').fill('Ann');
    await check(phone, 'join, name');
    await phone.getByRole('button', { name: 'Join game' }).click();
    await expect(phone.getByRole('heading', { name: 'You’re in!' })).toBeVisible();
    await check(phone, 'phone, lobby');
    await phone.getByRole('button', { name: 'I’m ready' }).click();

    await host.locator('.hc-roster__who').click();
    await expect(host.getByRole('dialog')).toBeVisible();
    await check(host, 'console, player dialog');
    await host.keyboard.press('Escape');
    await host.getByRole('button', { name: /Start the show/ }).click();
    await expect(host.locator('.hc-cats li').first()).toBeVisible();
    await check(host, 'console, round intro');
    await host.getByRole('button', { name: /Begin round/ }).click();
    // With one player there is nobody to roll against, so there may be no die to tap.
    await phone.locator('.play__roll button').first().click({ timeout: 5000 }).catch(() => undefined);
    await expect(host.locator('.hc-board')).toBeVisible({ timeout: 20_000 });
    // The top bar's controls are all there and all a thumb can hit, whatever the width.
    for (const name of [/TV/, /Undo/, /Pause/]) {
      const box = await host.locator('.hc-top__actions').getByRole(name.source === 'TV' ? 'link' : 'button', { name }).boundingBox();
      expect(box, `${name} in the top bar`).not.toBeNull();
      if (viewport.width <= 640) expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(40);
    }
    await expect(host.locator('.hc-top')).toHaveCSS('flex-wrap', 'nowrap');
    await check(host, 'console, board');
    // A held category's description lies over the grid without pushing anything off the screen.
    await host.locator('.hc-board__col h3[data-peek]').first().hover();
    await host.mouse.down();
    await expect(host.locator('.hc-board__blurb')).toBeVisible();
    await check(host, 'console, board, category description');
    await host.mouse.up();
    await host.locator('.hc-board__col button:not(:disabled)').first().click();
    await expect(host.locator('.hc-clue')).toBeVisible();
    await check(host, 'console, clue');
    await expect(phone.locator('.play__buzzer')).toBeVisible();
    await check(phone, 'phone, buzzer');
    // With an answer to rule on, the heading keeps the width of the card: the clock and its buttons go beneath it on a narrow screen.
    await phone.locator('.play__buzzer').click();
    const state = host.locator('.hc-clue__state');
    await expect(state).toContainText('Waiting for your ruling');
    await expect(state.locator('small')).toHaveText('Question hidden, its timer paused');
    const [heading, card] = [await state.boundingBox(), await host.locator('.hc-clue').boundingBox()];
    if (viewport.width <= 640) expect(heading!.width).toBeGreaterThan(card!.width * 0.6);
    expect(heading!.height).toBeLessThan(90);
    await check(host, 'console, ruling');

    const page = await open();
    for (const [name, path, ready] of [
      ['spectator', `/watch/${code}`, '.play__head'], ['TV code entry', '/tv', 'input'], ['TV', `/tv/${code}`, '.tv'],
      ['dashboard', '/host', '.mg-top'], ['packs', '/host/packs', '.mg-head'], ['history', '/host/history', '.mg-head'],
      ['host leaderboard', '/host/leaderboard', '.mg-head'], ['settings', '/host/settings', '.mg-set'], ['leaderboard', '/leaderboard', '.lb-page, .bz-center'],
      ['not found', '/nothing/here', '.bz-center'],
    ]) {
      await page.goto(path);
      await expect(page.locator(ready).first()).toBeVisible();
      await check(page, name);
    }
    await page.goto('/host/packs');
    await page.getByText('BuzzOff Starter Pack').first().click();
    await expect(page.locator('.mg-savebar')).toBeVisible();
    await check(page, 'pack editor');

    expect(problems).toEqual([]);
    await context.close();
  });
}
