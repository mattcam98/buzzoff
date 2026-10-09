/**
 * The longest things a pack and a player are allowed to write: a 600-character clue, a
 * 300-character answer, a 60-character category, a 240-character survey question, a 16-character
 * name. Every phone screen they reach still has to fit at every phone size.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { io } from 'socket.io-client';
import { expectFits } from './fit';
import { long } from './text';
import { closePagesAfterEachTest } from './tidy';

closePagesAfterEachTest();

const PHONE = { viewport: { width: 393, height: 659 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
/** Set FIT_SHOTS=1 to also save every screen at every size to e2e/.artifacts/fit. */
const SHOTS = process.env.FIT_SHOTS ? 'e2e/.artifacts/fit' : undefined;
const AVATAR = { emoji: '🐝', color: '#FFC400' };

const PACK = {
  title: 'The longest pack', description: '', author: '',
  categories: Array.from({ length: 3 }, (_, c) => ({
    id: `c${c}`,
    title: ['Extraordinarily Long Titles For Categories Of All Kinds Here', 'Words & Phrases', 'Supercalifragilisticexpialidocious'][c],
    clues: [100, 200].map((value, k) => ({ id: `c${c}-${k}`, value, question: long(600), answer: long(300, '.'), accept: [] })),
  })),
  surveys: Array.from({ length: 2 }, (_, i) => ({
    id: `s${i}`,
    question: long(240),
    answers: [{ text: long(80, ''), points: 50, aliases: [] }, { text: 'Short', points: 30, aliases: [] }],
  })),
};
const RULES = {
  name: long(60, '!'),
  rounds: [
    { mode: 'trivia', title: long(40, ''), categories: 2, cluesPerCategory: 2, valueMultiplier: 20, wagers: 0, wagerCap: 1_000_000, eliminateLowest: 0 },
    { mode: 'final', title: 'Final Trivia', wagerSec: 0, answerSec: 600, wagerCap: 1000 },
    { mode: 'fastMoney', title: 'Fast Money', questions: 2, participants: 'all', turnSec: 600, extraSecPerTurn: 0, blockDuplicates: false, reveal: 'atEnd', stakes: 'points', pointMultiplier: 10, target: 0, targetBonus: 0 },
  ],
  buzzer: { arbitration: 'first', collectionWindowMs: 150, maxCompensationMs: 150, buzzSec: 120, answerSec: 120, reopenOnIncorrect: true, rebuzz: false, incorrectPenaltyPct: 100, teamLockout: true },
  teams: { enabled: false, names: ['A', 'B'] },
  lateJoin: true,
  maxPlayers: 12,
};

async function hostOf(request: APIRequestContext, baseURL: string) {
  const pack = await (await request.post('/api/packs', { data: PACK })).json();
  const created = await request.post('/api/games', { data: { packIds: [pack.id], rules: RULES } });
  // A game keeps its own copy of the questions, so the pack can go at once: the other tests expect to find only the starter.
  await request.delete(`/api/packs/${pack.id}`);
  expect(created.status()).toBe(201);
  const { code, hostKey } = await created.json();
  const socket = io(baseURL, { transports: ['websocket'], auth: { role: 'host', code, token: hostKey } });
  await new Promise((resolve) => socket.once('state', resolve));
  let sent = 0;
  const host = async (action: object) => expect(await socket.emitWithAck('host:action', { id: `long-${code}-${sent++}`, action }), JSON.stringify(action)).toEqual({ ok: true });
  return { code, host, close: () => socket.disconnect() };
}

test('the longest clue, answer, names and scores still fit every phone', async ({ browser, request, baseURL }) => {
  test.setTimeout(240_000);
  const game = await hostOf(request, baseURL!);
  const other = await (await request.post(`/api/games/${game.code}/join`, { data: { name: 'Maximiliano José', avatar: AVATAR } })).json();
  const page: Page = await (await browser.newContext(PHONE)).newPage();
  await page.goto(`/join/${game.code}`);
  await page.getByLabel('Your name').fill('Wilhelmina Grace');
  await page.getByRole('button', { name: 'Join game' }).click();
  await expect(page.getByRole('heading', { name: 'You’re in!' })).toBeVisible();
  await expectFits(page, 'long-lobby', undefined, SHOTS);
  await page.getByRole('button', { name: 'I’m ready' }).click();

  await game.host({ t: 'start' });
  await expect(page.locator('.play__panel h1')).toBeVisible();
  await expectFits(page, 'long-intro', undefined, SHOTS);
  await game.host({ t: 'round.begin' });
  const me = await page.evaluate((code) => JSON.parse(localStorage.getItem(`buzzoff.seat.${code}`)!).playerId as string, game.code);
  await game.host({ t: 'score.set', id: me, score: -9_876_500 });
  await game.host({ t: 'score.set', id: other.playerId, score: 9_876_500 });
  await game.host({ t: 'control.set', id: me });
  await expect(page.getByRole('heading', { name: /Tell the host/ })).toBeVisible();
  await expectFits(page, 'long-board', undefined, SHOTS);

  await game.host({ t: 'clue.select', cat: 0, idx: 0 });
  await expect(page.locator('.play__buzzer[data-state="open"]')).toBeVisible();
  await expectFits(page, 'long-clue', undefined, SHOTS);
  await page.locator('.play__buzzer').dispatchEvent('pointerdown');
  await expect(page.locator('.play__buzzer[data-state="yours"]')).toBeVisible();
  await expectFits(page, 'long-answering', undefined, SHOTS);
  await game.host({ t: 'judge', correct: true });
  await expect(page.locator('.play__delta')).toBeVisible();
  await expectFits(page, 'long-answer', undefined, SHOTS);
  await game.host({ t: 'clue.continue' });
  await game.host({ t: 'round.end' });
  await expect(page.getByRole('heading', { name: 'Standings' })).toBeVisible();
  await expectFits(page, 'long-standings', undefined, SHOTS);

  await game.host({ t: 'round.next' });
  await game.host({ t: 'round.begin' });
  await expect(page.getByLabel('Wager amount')).toBeVisible();
  await expectFits(page, 'long-final-wager', undefined, SHOTS);
  await game.host({ t: 'final.advance' });
  await page.getByLabel('Your answer').fill(long(120, ''));
  await expect(page.getByRole('button', { name: '✓ Saved' })).toBeVisible();
  await expectFits(page, 'long-final-answer', undefined, SHOTS);
  await game.host({ t: 'final.advance' });
  await game.host({ t: 'final.show' });
  await expectFits(page, 'long-final-reveal', undefined, SHOTS);
  await game.host({ t: 'final.judge', correct: false });
  await game.host({ t: 'final.show' });
  await game.host({ t: 'final.judge', correct: true });
  await expectFits(page, 'long-final-judged', undefined, SHOTS);
  await game.host({ t: 'round.end' });

  await game.host({ t: 'round.next' });
  await game.host({ t: 'round.begin' });
  await game.host({ t: 'fm.start' });
  await expect(page.getByLabel('Your answer')).toBeVisible();
  await expectFits(page, 'long-survey-question', undefined, SHOTS);
  await page.getByLabel('Your answer').fill(long(80, ''));
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByLabel('Your answer').fill('short');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('button', { name: 'Lock in my answers' })).toBeVisible();
  await expectFits(page, 'long-survey-review', undefined, SHOTS);
  await page.getByRole('button', { name: 'Lock in my answers' }).click();
  await game.host({ t: 'fm.endTurn' });
  for (let step = 0; step < 4; step++) await game.host({ t: 'fm.reveal' });
  await expectFits(page, 'long-survey-reveal', undefined, SHOTS);
  await game.host({ t: 'fm.next' });
  await expectFits(page, 'long-survey-result', undefined, SHOTS);
  await game.host({ t: 'round.end' });
  await expect(page.getByRole('heading', { name: /You finished|You won/ })).toBeVisible();
  await expectFits(page, 'long-finished', undefined, SHOTS);
  game.close();
});
