/** The host console's dialogs and shortcuts, and what happens when part of the app fails to load. */
import { expect, test } from '@playwright/test';
import { closePagesAfterEachTest } from './tidy';

closePagesAfterEachTest();

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

test('dialogs keep their focus and shortcuts never hijack a focused control', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await host.goto('/host/new');
  await host.getByRole('button', { name: /^Create/ }).click();
  await expect(host.getByRole('heading', { name: 'Waiting for players' })).toBeVisible();
  const code = host.url().slice(-4);

  const ann = await (await browser.newContext(PHONE)).newPage();
  await ann.goto(`/join/${code}`);
  await ann.getByLabel('Your name').fill('Ann');
  await ann.getByRole('button', { name: 'Join game' }).click();
  await expect(host.getByRole('heading', { name: '1 player in the room' })).toBeVisible();
  await ann.getByRole('button', { name: 'I’m ready' }).click();
  await expect(host.getByRole('button', { name: /Start the show/ })).toBeEnabled();

  // Enter on a focused button presses that button, not "Start the show".
  await host.getByRole('button', { name: 'Copy join link' }).focus();
  await host.keyboard.press('Enter');
  await host.waitForTimeout(300);
  await expect(host.getByRole('heading', { name: '1 player in the room' })).toBeVisible();

  // Typing in a dialog is not interrupted when the game updates behind it.
  const who = host.locator('.hc-roster__who');
  await who.click();
  const dialog = host.getByRole('dialog');
  const score = dialog.getByLabel('Score');
  await score.fill('1');
  await ann.getByRole('button', { name: '✓ Ready' }).click();
  await expect(host.locator('.hc-roster').getByText('ready')).toHaveCount(0);
  await ann.getByRole('button', { name: 'I’m ready' }).click();
  await expect(host.locator('.hc-roster').getByText('ready')).toBeVisible();
  await expect(score).toBeFocused();

  // On the TV, the "Ready" pill sits above its player, a little outside the row. Nothing it is in may cut that part off.
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await tv.goto(`/tv/${code}`);
  await expect(tv.locator('.tv-lobby__ready')).toBeVisible();
  await tv.locator('.tv-lobby__players').evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const cutOffBy = await tv.locator('.tv-lobby__ready').evaluate((pill) => {
    const r = pill.getBoundingClientRect();
    for (let box = pill.parentElement; box; box = box.parentElement) {
      const edge = box.getBoundingClientRect();
      const clips = getComputedStyle(box).overflow !== 'visible';
      if (clips && (r.top < edge.top || r.left < edge.left || r.right > edge.right || r.bottom > edge.bottom)) return box.className;
    }
    return null;
  });
  expect(cutOffBy).toBeNull();
  await tv.close();
  await host.keyboard.type('500');
  await host.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(host.locator('.hc-roster__score')).toContainText('1,500');
  await expect(who).toBeFocused();

  // An emptied score field means "leave the score alone", not "set it to zero".
  await who.click();
  await dialog.getByLabel('Score').fill('');
  await dialog.getByLabel('Name').fill('Annie');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(host.locator('.hc-roster')).toContainText('Annie');
  await expect(host.locator('.hc-roster__score')).toContainText('1,500');
});

test('the space bar is the next step, never a second press of whatever the mouse clicked last', async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await host.goto('/host/new');
  await host.getByRole('button', { name: /^Create/ }).click();
  await expect(host.getByRole('heading', { name: 'Waiting for players' })).toBeVisible();
  const ann = await (await browser.newContext(PHONE)).newPage();
  await ann.goto(`/join/${host.url().slice(-4)}`);
  await ann.getByLabel('Your name').fill('Ann');
  await ann.getByRole('button', { name: 'Join game' }).click();
  await expect(host.getByRole('heading', { name: '1 player in the room' })).toBeVisible();

  // Ann has not tapped ready, so there is no step to take. A score nudged with the mouse stays nudged once.
  const start = host.getByRole('button', { name: /Start the show/ });
  const score = host.locator('.hc-roster__score .bz-num');
  await expect(start).toBeDisabled();
  await host.getByRole('button', { name: /^Give \d+ to Ann/ }).click();
  await expect(score).toHaveText('100');
  await host.keyboard.press('Space');
  await host.waitForTimeout(1000); // a second nudge would be counting up by now
  await expect(score).toHaveText('100');

  // And once there is a step, Space takes it, even straight after flipping a switch with the mouse.
  await ann.getByRole('button', { name: 'I’m ready' }).click();
  await expect(start).toBeEnabled();
  const lock = host.getByLabel('Lock the room');
  await lock.click();
  await expect(lock).toBeChecked();
  await host.keyboard.press('Space');
  await expect(host.getByRole('button', { name: /Begin round/ })).toBeVisible();
});

test('a page whose code fails to load reloads once, then says so instead of looping', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  let loads = 0;
  page.on('framenavigated', (frame) => frame === page.mainFrame() && loads++);
  await page.route(/\/assets\/host-.*\.js$/, (route) => route.abort());
  await page.goto('/host');
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  expect(loads).toBe(2);

  // Phones never depend on a second download: the join screen is in the first one.
  await page.goto('/');
  await expect(page.getByLabel('Room code')).toBeVisible();
});
