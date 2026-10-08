/** The host console's dialogs and shortcuts, and what happens when part of the app fails to load. */
import { expect, test } from '@playwright/test';

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

  // On the TV, the "Ready" pill above a player in the top row is not cut off by the list that holds it.
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await tv.goto(`/tv/${code}`);
  await expect(tv.locator('.tv-lobby__ready')).toBeVisible();
  await tv.locator('.tv-lobby__players').evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const [pill, list] = await Promise.all([tv.locator('.tv-lobby__ready').boundingBox(), tv.locator('.tv-lobby__players').boundingBox()]);
  expect(pill!.y).toBeGreaterThanOrEqual(list!.y);
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
