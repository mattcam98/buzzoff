/**
 * The phone screens that the full-show test does not reach: joining, and a
 * crowded room where lists are long enough to need their own scrolling.
 */
import { expect, test, type Page } from '@playwright/test';
import { io } from 'socket.io-client';
import { expectFits, expectFitsWithKeyboard } from './fit';

const SHOTS = 'e2e/.artifacts/fit';
const PHONE = { viewport: { width: 393, height: 659 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
const AVATAR = { emoji: '🐝', color: '#FFC400' };

async function createGame(request: import('@playwright/test').APIRequestContext, baseURL: string) {
  const packs = await (await request.get('/api/packs')).json();
  const presets = await (await request.get('/api/presets')).json();
  const rules = { ...presets.find((p: { id: string }) => p.id === 'classic').rules, maxPlayers: 20 };
  const { code, hostKey } = await (await request.post('/api/games', { data: { packIds: [packs[0].id], rules } })).json();
  const socket = io(baseURL, { transports: ['websocket'], auth: { role: 'host', code, token: hostKey } });
  await new Promise((resolve) => socket.once('state', resolve));
  let n = 0;
  const host = async (action: object) => {
    const ack = await socket.emitWithAck('host:action', { id: `fit-${code}-${n++}`, action });
    expect(ack).toEqual({ ok: true });
  };
  return { code, host, close: () => socket.disconnect() };
}

test('joining fits one screen at every phone size, with and without the keyboard', async ({ browser, request, baseURL }) => {
  const game = await createGame(request, baseURL!);
  const page = await (await browser.newContext(PHONE)).newPage();

  await page.goto('/');
  await expect(page.locator('.home__code input')).toBeFocused();
  await expectFits(page, 'join-code', undefined, SHOTS);
  await expectFitsWithKeyboard(page, 'join-code', '.home__code input', ['#room-status'], SHOTS);

  // A complete code moves straight on to the second step.
  await page.locator('.home__code input').fill(game.code);
  await expect(page.getByRole('button', { name: 'Join game' })).toBeVisible();
  await expectFits(page, 'join-who', undefined, SHOTS);
  await page.getByLabel('Your name').fill('Bartholomew the 3rd'); // trimmed to the 16-character limit by the field
  await expectFitsWithKeyboard(page, 'join-who', '[aria-label="Your name"]', ['.home__who .bz-btn--primary', '.home__room'], SHOTS);

  // The room chip goes back to the code, and a bad code says so without leaving the screen.
  await page.locator('.home__room').click();
  await page.locator('.home__code input').fill('QQQQ');
  await expect(page.locator('#room-status')).toContainText('No game with that code');
  await expectFits(page, 'join-missing');
  game.close();
});

test('a crowded room: long lists scroll inside themselves, never the page', async ({ browser, request, baseURL }) => {
  const game = await createGame(request, baseURL!);
  // Fifteen players join over the API; the sixteenth is a real phone.
  const ids: string[] = [];
  for (let i = 0; i < 15; i++) {
    const res = await (await request.post(`/api/games/${game.code}/join`, { data: { name: `Player ${i + 1}`, avatar: AVATAR } })).json();
    ids.push(res.playerId);
  }
  const page: Page = await (await browser.newContext(PHONE)).newPage();
  await page.goto(`/join/${game.code}`);
  await page.getByLabel('Your name').fill('Zed');
  await page.getByRole('button', { name: 'Join game' }).click();
  await expect(page.getByRole('heading', { name: 'You’re in!' })).toBeVisible();
  await expectFits(page, 'crowd-lobby', undefined, SHOTS);

  // The profile editor is a sheet over the lobby and has to fit as well.
  await page.getByRole('button', { name: 'Change name or avatar' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // The sheet springs in with a slight overshoot; measure it once it has come to rest.
  await page.locator('.bz-modal__panel').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  for (const [width, height] of [[320, 480], [375, 553], [393, 659]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
    const panel = await page.locator('.bz-modal__panel').boundingBox();
    expect(panel!.y, `editor top at ${width}×${height}`).toBeGreaterThanOrEqual(0);
    expect(panel!.y + panel!.height, `editor bottom at ${width}×${height}`).toBeLessThanOrEqual(height);
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Save' })).toBeInViewport();
  }
  await page.setViewportSize(PHONE.viewport);
  await page.keyboard.press('Escape');

  await game.host({ t: 'start' });
  for (const [i, id] of ids.entries()) await game.host({ t: 'score.set', id, score: (i + 1) * 100 });
  await game.host({ t: 'round.begin' });
  // The roll for the first pick, with sixteen dice to show, fits too.
  await expect(page.getByRole('heading', { name: 'Tap to roll' })).toBeVisible();
  await expect(page.locator('.play__rolls li')).toHaveCount(16);
  await expectFits(page, 'crowd-roll', undefined, SHOTS);
  // Whoever has the pick, every phone shows the board, to look at and not to press.
  await game.host({ t: 'control.set', id: ids[0] });
  await expect(page.getByRole('heading', { name: 'Player 1 is picking' })).toBeVisible();
  await expect(page.locator('.play__grid').getByRole('button')).toHaveCount(0);
  await expectFits(page, 'crowd-board', undefined, SHOTS);

  await game.host({ t: 'round.end' });
  await expect(page.getByRole('heading', { name: /You finished 16th/ })).toBeVisible();
  await expect(page.locator('.play__board li')).toHaveCount(16);
  await expectFits(page, 'crowd-finished', undefined, SHOTS);

  // Your own row stays on screen however far down the table you are.
  const mine = page.locator('.play__board li[data-me]');
  await expect(mine).toBeInViewport();
  await page.locator('.play__board').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(mine).toBeInViewport();
  game.close();
});
