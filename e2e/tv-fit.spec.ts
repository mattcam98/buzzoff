/**
 * The shared screen with a full room, and with the longest text a pack may hold. The other tests
 * play with three people and short questions, and those fit anywhere; these check that twenty
 * people and six hundred characters still do, on a laptop, a television and a 4K display: nothing
 * off the edge of the screen, nothing cut off by its own box, no text outside the tile drawn
 * around it, no block run into the next.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { io } from 'socket.io-client';
import { long } from './text';
import { closePagesAfterEachTest } from './tidy';

closePagesAfterEachTest();

const SIZES: [width: number, height: number][] = [[1280, 720], [1920, 1080], [3840, 2160]];
const AVATARS = [['🐝', '#FFC400'], ['🦊', '#FF4D8D'], ['🐙', '#3DDCFF'], ['🦖', '#7CFF6B'], ['🐸', '#B58CFF'], ['🦄', '#FF8A3D']];
/** Long names, short names, and the sixteen characters a name may run to. */
const NAMES = ['Bartholomew XVII', 'Al', 'Wilhelmina Grace', 'Zed', 'Maximiliano José', 'Bo', 'Christopher Lee', 'Ann', 'Persephone Quinn', 'Dee'];
const names = (count: number) => Array.from({ length: count }, (_, i) => NAMES[i] ?? `Player Number ${i + 1}`);

const BUZZER = { arbitration: 'first', collectionWindowMs: 150, maxCompensationMs: 150, buzzSec: 60, answerSec: 60, reopenOnIncorrect: true, rebuzz: false, incorrectPenaltyPct: 100, teamLockout: true };
const BOARD = { mode: 'trivia', title: 'Board One', categories: 6, cluesPerCategory: 5, valueMultiplier: 1, wagers: 0, wagerCap: 1000, eliminateLowest: 0 };
const FINAL = { mode: 'final', title: 'Final Trivia', wagerSec: 0, answerSec: 600, wagerCap: 1000 };
const SURVEY = { mode: 'fastMoney', title: 'Survey Scramble', questions: 3, participants: 'all', turnSec: 600, extraSecPerTurn: 0, blockDuplicates: false, reveal: 'atEnd', stakes: 'points', pointMultiplier: 10, target: 0, targetBonus: 0 };
const rules = (rounds: object[], teams = false) => ({ name: 'A Full House', rounds, buzzer: BUZZER, teams: { enabled: teams, names: ['Team Honey', 'Team Sting'] }, lateJoin: true, maxPlayers: 20 });

/**
 * A game with a room full of players. Only the first has a phone, and that is enough to start, to buzz and to write.
 * It is played from the starter pack unless it is given one of its own.
 */
async function room(request: APIRequestContext, baseURL: string, gameRules: object, players: string[], pack?: object) {
  const packs = await (await request.get('/api/packs')).json();
  const own = pack && (await (await request.post('/api/packs', { data: pack })).json());
  const created = await request.post('/api/games', { data: { packIds: [own?.id ?? packs[0].id], rules: gameRules } });
  // A game keeps its own copy of the questions, so the pack can go at once: the other tests expect to find only the starter.
  if (own) await request.delete(`/api/packs/${own.id}`);
  expect(created.status()).toBe(201);
  const { code, hostKey } = await created.json();
  const seats: { playerId: string; token: string }[] = [];
  for (const [i, name] of players.entries()) {
    const [emoji, color] = AVATARS[i % AVATARS.length];
    seats.push(await (await request.post(`/api/games/${code}/join`, { data: { name, avatar: { emoji, color } } })).json());
  }
  const connect = async (auth: object) => {
    const socket = io(baseURL, { transports: ['websocket'], auth });
    socket.on('probe', (ack: () => void) => ack());
    await new Promise((resolve) => socket.once('state', resolve));
    return socket;
  };
  const hostSocket = await connect({ role: 'host', code, token: hostKey });
  // The host is sent who is up in a Fast Money round; a test that plays one needs to know.
  let state: { round: { turns: string[][] } } | null = null;
  hostSocket.on('state', (view) => (state = view));
  const phone = await connect({ role: 'player', code, token: seats[0].token });
  let sent = 0;
  const host = async (action: object) => expect(await hostSocket.emitWithAck('host:action', { id: `tv-${code}-${sent++}`, action }), JSON.stringify(action)).toEqual({ ok: true });
  expect(await phone.emitWithAck('player:action', { id: `ready-${code}`, action: { t: 'ready', ready: true } })).toEqual({ ok: true });
  const write = async (action: object) => expect(await phone.emitWithAck('player:action', { id: `phone-${code}-${sent++}`, action })).toEqual({ ok: true });
  return { code, seats, host, write, state: () => state, buzz: () => phone.emitWithAck('buzz'), close: () => [hostSocket, phone].forEach((s) => s.disconnect()) };
}

/** Runs in the page. Lists what does not fit, in words a failure can show. */
function faults(): string[] {
  const W = innerWidth;
  const H = innerHeight;
  const found = new Set<string>();
  const shown = (el: Element) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0;
  const say = (el: Element) => `<${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(' ')[0]}` : ''}> “${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)}”`;

  for (const el of document.querySelectorAll('.tv h1, .tv h2, .tv p, .tv li, .tv strong, .tv b, .tv .bz-num, .tv .bz-avatar')) {
    const r = el.getBoundingClientRect();
    if (shown(el) && r.width && r.height && (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1)) found.add(`${say(el)} is off the screen`);
  }
  // A name that ends in an ellipsis was shortened on purpose; anything else that overflows its box was not.
  for (const el of document.querySelectorAll('.tv ul, .tv ol, .tv li, .tv p, .tv h1, .tv h2, .tv div')) {
    const style = getComputedStyle(el);
    if (!shown(el) || style.overflowY === 'visible' || style.textOverflow === 'ellipsis') continue;
    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) found.add(`${say(el)} is cut off`);
  }
  // A tile, a card or a pill is drawn around its text, and the text has to be inside it, top and bottom.
  for (const el of document.querySelectorAll('.tv *')) {
    const style = getComputedStyle(el);
    const drawn = style.backgroundImage !== 'none' || !/^(rgba\(0, 0, 0, 0\)|transparent)$/.test(style.backgroundColor) || parseFloat(style.borderTopWidth) > 0;
    if (!shown(el) || style.display === 'contents' || style.backgroundClip === 'text' || !drawn) continue;
    const box = el.getBoundingClientRect();
    let top = Infinity;
    let bottom = -Infinity;
    const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      // Something pinned to a corner of its box, as a "Ready" pill is, is meant to stick out of it.
      let pinned = getComputedStyle(node.parentElement!).visibility === 'hidden' || !node.textContent?.trim();
      for (let up = node.parentElement; up && up !== el; up = up.parentElement) pinned ||= ['absolute', 'fixed'].includes(getComputedStyle(up).position);
      if (pinned) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        top = Math.min(top, line.top);
        bottom = Math.max(bottom, line.bottom);
      }
    }
    if (Math.max(bottom - box.bottom, box.top - top) > 3) found.add(`${say(el)} has text outside it`);
  }
  for (const parent of document.querySelectorAll('.tv, .tv-main > *')) {
    const blocks = [...parent.children].filter((k) => shown(k) && !['absolute', 'fixed'].includes(getComputedStyle(k).position));
    blocks.forEach((block, i) => {
      const a = block.getBoundingClientRect();
      const next = blocks[i + 1]?.getBoundingClientRect();
      const sideBySide = !!next && (a.right <= next.left + 1 || next.right <= a.left + 1);
      if (next && !sideBySide && a.bottom > next.top + 2) found.add(`${say(block)} runs into ${say(blocks[i + 1])}`);
      for (const inner of block.querySelectorAll('li, p, h1, h2, strong')) {
        const r = inner.getBoundingClientRect();
        if (shown(inner) && r.height && (r.top < a.top - 3 || r.bottom > a.bottom + 3)) found.add(`${say(inner)} spills out of ${say(block)}`);
      }
    });
  }
  return [...found];
}

/** Measure the scene now on screen at every size. Problems are collected rather than thrown, so one run reports them all. */
async function measureScene(tv: Page, scene: string, problems: string[]) {
  for (const [width, height] of SIZES) {
    await tv.setViewportSize({ width, height });
    await tv.evaluate(async () => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null))));
      const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    });
    for (const fault of await tv.evaluate(faults)) problems.push(`[${scene} @ ${width}×${height}] ${fault}`);
  }
}

test('the shared screen goes full screen from its button or the F key, and the button gets out of the way', async ({ browser, request, baseURL }) => {
  const game = await room(request, baseURL!, rules([BOARD]), names(3));
  const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await tv.goto(`/tv/${game.code}`);
  const isFull = () => tv.evaluate(() => document.fullscreenElement !== null);
  const enter = tv.getByRole('button', { name: 'Full screen', exact: true });
  const leave = tv.getByRole('button', { name: 'Exit full screen' });
  await expect(enter).toBeVisible();
  await enter.click();
  await expect.poll(isFull).toBe(true);
  await expect(leave).toBeVisible();
  // That click was the screen's first, so it turned the sound on as well.
  await expect(tv.getByRole('button', { name: /turn sound on/ })).toHaveCount(0);
  // With nobody at the mouse the button and the pointer go away, and come back when it moves.
  await expect(leave).toHaveCount(0, { timeout: 6000 });
  await expect(tv.locator('.tv')).toHaveAttribute('data-idle', 'true');
  await tv.mouse.move(300, 300);
  await expect(leave).toBeVisible();
  await tv.keyboard.press('f');
  await expect.poll(isFull).toBe(false);
  await expect(enter).toBeVisible();
  game.close();
});

test('a room of twenty fits the shared screen from the lobby to the finish', async ({ browser, request, baseURL }) => {
  test.setTimeout(180_000);
  const game = await room(request, baseURL!, rules([BOARD, FINAL]), names(20));
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errors: string[] = [];
  tv.on('pageerror', (err) => errors.push(err.message));
  await tv.goto(`/tv/${game.code}`);
  const problems: string[] = [];
  const scene = async (name: string, ready: () => Promise<unknown>) => {
    await ready();
    await measureScene(tv, name, problems);
  };

  await scene('lobby', () => expect(tv.locator('.tv-lobby__players li')).toHaveCount(20));
  await game.host({ t: 'start' });
  await scene('round intro', () => expect(tv.locator('.tv-intro h1')).toHaveText('Board One'));
  await game.host({ t: 'round.begin' });
  await scene('roll for the first pick', () => expect(tv.locator('.tv-roll__players li')).toHaveCount(20));

  // Hand out scores of every width, some of them negative, then put the board up.
  for (const [i, seat] of game.seats.entries()) await game.host({ t: 'score.set', id: seat.playerId, score: (i - 4) * 1300 });
  await game.host({ t: 'control.set', id: game.seats[0].playerId });
  await scene('board', () => expect(tv.locator('.tv-board__cell')).toHaveCount(30));
  // Every category, the room code and every one of the twenty podiums are on the screen, not beyond its edge.
  await expect(tv.locator('.tv-board__cat')).toHaveCount(6);
  await expect(tv.locator('.tv-podium')).toHaveCount(20);

  await game.host({ t: 'clue.select', cat: 0, idx: 0 });
  await scene('clue', () => expect(tv.locator('.tv-status--open')).toBeVisible());
  expect(await game.buzz()).toMatchObject({ ok: true, data: { status: 'registered' } });
  await scene('answering', () => expect(tv.locator('.tv-answering h2')).toBeVisible());
  await game.host({ t: 'judge', correct: true });
  await scene('answer', () => expect(tv.locator('.tv-result__answer')).toBeVisible());
  await game.host({ t: 'clue.continue' });
  await game.host({ t: 'round.end' });
  await scene('standings', () => expect(tv.locator('.tv-standings li')).toHaveCount(20));

  await game.host({ t: 'round.next' });
  await game.host({ t: 'round.begin' });
  await game.host({ t: 'final.advance' });
  await scene('final, everyone writing', () => expect(tv.locator('.tv-final__waiting li')).toHaveCount(20));
  await game.host({ t: 'final.advance' });
  for (let shown = 0; shown < 20; shown++) {
    await game.host({ t: 'final.show' });
    await game.host({ t: 'final.judge', correct: shown % 2 === 0 });
  }
  // The latest fifteen verdicts are up, and a sixteenth chip stands for the five before them.
  await scene('final, everyone judged', () => expect(tv.locator('.tv-final__done li').first()).toHaveText('+5 earlier'));
  await expect(tv.locator('.tv-final__done li')).toHaveCount(16);
  await game.host({ t: 'round.end' });
  await scene('finale', () => expect(tv.locator('.tv-finale__champ')).toHaveCount(1));

  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
  game.close();
});

test('survey totals and a winning team fit the shared screen', async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();

  // Everybody plays: the round ends on a table of all twelve.
  const survey = await room(request, baseURL!, rules([SURVEY]), names(12));
  await tv.goto(`/tv/${survey.code}`);
  await survey.host({ t: 'start' });
  await survey.host({ t: 'round.begin' });
  await survey.host({ t: 'fm.start' });
  await expect(tv.locator('.tv-crowd__progress li')).toHaveCount(12);
  await measureScene(tv, 'survey, everyone answering', problems);
  await survey.host({ t: 'fm.endTurn' });
  for (let step = 0; step < 6; step++) await survey.host({ t: 'fm.reveal' });
  await survey.host({ t: 'fm.next' });
  await expect(tv.locator('.tv-crowd__totals li')).toHaveCount(12);
  await measureScene(tv, 'survey totals', problems);
  survey.close();

  // Teams: six champions share the stage, and the standings carry the team scores underneath.
  const teams = await room(request, baseURL!, rules([BOARD, BOARD], true), names(12));
  await tv.goto(`/tv/${teams.code}`);
  await teams.host({ t: 'start' });
  for (const [i, seat] of teams.seats.entries()) await teams.host({ t: 'score.set', id: seat.playerId, score: i % 2 ? 100 : 1000 + i });
  await teams.host({ t: 'round.end' });
  await expect(tv.locator('.tv-standings__teams li')).toHaveCount(2);
  // The gold outline is for whoever leads the table. The first team in the list is not that.
  await expect(tv.locator('.tv-standings li[data-lead]')).toHaveCount(1);
  await expect(tv.locator('.tv-standings__teams li').first()).toHaveCSS('box-shadow', 'none');
  await measureScene(tv, 'standings with teams', problems);
  await teams.host({ t: 'game.end' });
  await expect(tv.locator('.tv-finale__champ')).toHaveCount(6);
  await expect(tv.locator('.tv-finale__team')).toHaveText('Team Honey take it');
  await measureScene(tv, 'finale, a team of six', problems);
  teams.close();

  expect(problems).toEqual([]);
});

test('the longest question and answer a pack may hold fit the shared screen', async ({ browser, request, baseURL }) => {
  test.setTimeout(120_000);
  // Seven categories with titles that fill a line: six for the board and one for the final. Every clue, answer and survey question is as long as it may be.
  const pack = {
    title: 'The longest pack',
    categories: Array.from({ length: 7 }, (_, c) => ({ id: `c${c}`, title: long(60, ''), clues: [{ id: `c${c}-0`, value: 100, question: long(600), answer: long(300, '.') }] })),
    surveys: Array.from({ length: 5 }, (_, s) => ({ id: `s${s}`, question: long(240), answers: [{ text: long(80, ''), points: 40 }, { text: 'Short', points: 20 }] })),
  };
  const FAST_MONEY = { ...SURVEY, title: long(40, ''), questions: 5, participants: 'top2', stakes: 'decider' };
  const rounds = [{ ...BOARD, title: long(40, ''), cluesPerCategory: 1 }, { ...FINAL, title: long(40, '') }, FAST_MONEY];
  const game = await room(request, baseURL!, { ...rules(rounds), name: long(60, '!') }, names(8), pack);
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errors: string[] = [];
  tv.on('pageerror', (err) => errors.push(err.message));
  await tv.goto(`/tv/${game.code}`);
  const problems: string[] = [];
  const scene = async (name: string, ready: () => Promise<unknown>) => {
    await ready();
    await measureScene(tv, name, problems);
  };

  await scene('lobby', () => expect(tv.locator('.tv-lobby__players li')).toHaveCount(8));
  await game.host({ t: 'start' });
  await scene('round intro', () => expect(tv.locator('.tv-intro__cats li')).toHaveCount(6));
  await game.host({ t: 'round.begin' });
  // The first seat is last on points, so its answer to the final is the first one shown.
  for (const [i, seat] of game.seats.entries()) await game.host({ t: 'score.set', id: seat.playerId, score: i * 1300 });
  await game.host({ t: 'control.set', id: game.seats[0].playerId });
  await scene('board', () => expect(tv.locator('.tv-board__cell')).toHaveCount(6));

  await game.host({ t: 'clue.select', cat: 0, idx: 0 });
  await scene('clue', () => expect(tv.locator('.tv-status--open')).toBeVisible());
  // All six hundred characters are there to be read, in type brought down until they fit the card.
  await expect(tv.locator('.tv-clue__q')).toHaveText(long(600));
  await expect(tv.locator('.tv-clue__body')).toHaveAttribute('style', /--fit:\s*0\.\d+/);
  expect(await game.buzz()).toMatchObject({ ok: true, data: { status: 'registered' } });
  await game.host({ t: 'judge', correct: true });
  await scene('answer', () => expect(tv.locator('.tv-result__answer strong')).toHaveText(long(300, '.')));
  await game.host({ t: 'clue.continue' });
  await game.host({ t: 'round.end' });

  await game.host({ t: 'round.next' });
  await scene('final intro', () => expect(tv.locator('.tv-intro__cats--one')).toBeVisible());
  await game.host({ t: 'round.begin' });
  await game.host({ t: 'final.advance' });
  await game.write({ t: 'final.answer', text: long(120, '.') });
  await scene('final, everyone writing', () => expect(tv.locator('.tv-final__waiting li[data-done]')).toHaveCount(1));
  await game.host({ t: 'final.advance' });
  await game.host({ t: 'final.show' });
  await scene('final, a long answer shown', () => expect(tv.locator('.tv-final__card strong')).toHaveText(long(120, '.')));
  await game.host({ t: 'final.judge', correct: true });
  for (let shown = 1; shown < 8; shown++) {
    await game.host({ t: 'final.show' });
    await game.host({ t: 'final.judge', correct: false });
  }
  await scene('final, the answer', () => expect(tv.locator('.tv-result__answer strong')).toHaveText(long(300, '.')));
  await game.host({ t: 'round.end' });

  // Fast Money: five questions of 240 characters, and the host types an answer of eighty for each of the two contestants.
  await game.host({ t: 'round.next' });
  await game.host({ t: 'round.begin' });
  for (const [contestant] of game.state()!.round.turns) {
    await game.host({ t: 'fm.start' });
    for (let q = 0; q < 5; q++) await game.host({ t: 'fm.setAnswer', playerId: contestant, q, text: long(80, '') });
    await game.host({ t: 'fm.endTurn' });
  }
  for (let step = 0; step < 20; step++) await game.host({ t: 'fm.reveal' });
  await scene('fast money, all revealed', () => expect(tv.locator('.tv-fm__cell b:not(:empty)')).toHaveCount(10));
  await game.host({ t: 'fm.next' });
  await scene('fast money, the result', () => expect(tv.locator('.tv-fm__top')).toHaveCount(5));

  expect(problems).toEqual([]);
  expect(errors).toEqual([]);
  game.close();
});
