/**
 * A whole show, played by real browsers: one host console, one TV and three
 * phones. It walks every mode (board, hidden wager, final, Fast Money) and
 * saves a screenshot of each surface along the way to e2e/.artifacts/shots.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectFits, expectFitsWithKeyboard } from './fit';

const SHOTS = 'e2e/.artifacts/shots';
/** Set FIT_SHOTS=1 to also save every phone screen at every size to e2e/.artifacts/fit. */
const FIT_SHOTS = process.env.FIT_SHOTS ? 'e2e/.artifacts/fit' : undefined;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

const RULES = {
  name: 'E2E Night',
  rounds: [
    { mode: 'trivia', title: 'Board One', categories: 3, cluesPerCategory: 2, valueMultiplier: 1, wagers: 1, wagerCap: 1000, eliminateLowest: 0 },
    { mode: 'final', title: 'Final Trivia', wagerSec: 45, answerSec: 60, wagerCap: 1000 },
    { mode: 'fastMoney', title: 'Fast Money', questions: 2, participants: 'top2', turnSec: 45, extraSecPerTurn: 10, blockDuplicates: true, reveal: 'atEnd', stakes: 'decider', pointMultiplier: 10, target: 0, targetBonus: 0 },
  ],
  buzzer: {
    arbitration: 'first', collectionWindowMs: 150, maxCompensationMs: 150,
    buzzSec: 30, answerSec: 20, reopenOnIncorrect: true, rebuzz: false, incorrectPenaltyPct: 100, teamLockout: true,
  },
  teams: { enabled: false, names: ['Team Honey', 'Team Sting'] },
  lateJoin: true,
  maxPlayers: 12,
};

/** Uncaught exceptions from any page opened during a test; every test ends by checking there were none. */
const pageErrors: string[] = [];
test.beforeEach(() => {
  pageErrors.length = 0;
});
const watch = (page: Page) => {
  page.on('pageerror', (err) => pageErrors.push(`${page.url()}: ${err.message}`));
  return page;
};
test.afterEach(() => expect(pageErrors).toEqual([]));

let shot = 0;
const snap = async (page: Page, name: string) => {
  await page.waitForTimeout(700); // let entrance animations settle
  await page.screenshot({ path: `${SHOTS}/${String(++shot).padStart(2, '0')}-${name}.png` });
  // Every phone screen that is photographed is also measured at every phone size.
  if (name.startsWith('phone-')) await expectFits(page, name, undefined, FIT_SHOTS);
};

async function joinAs(browser: Browser, code: string, name: string): Promise<Page> {
  const page = watch(await (await browser.newContext(PHONE)).newPage());
  await page.goto(`/join/${code}`);
  await expect(page.locator('#room-status')).toContainText('E2E Night');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join game' }).click();
  await expect(page.getByRole('heading', { name: 'You’re in!' })).toBeVisible();
  return page;
}

const buzzer = (page: Page) => page.locator('.play__buzzer');

/**
 * Press a host shortcut once the button it belongs to is on screen. Waiting for
 * the label is what a human does too: you press C when you see "Correct".
 */
async function key(host: Page, shortcut: 'Space' | 'c' | 'x' | 'u' | 'r' | 'p', label: RegExp) {
  await expect(host.locator(`.hc [data-hotkey="${shortcut.toLowerCase()}"]:not(:disabled)`).filter({ hasText: label })).toBeVisible();
  await host.keyboard.press(shortcut);
}

/** Play the roll for the first pick the way a room does: every phone that may roll taps its die, tie-breaks included. */
async function rollOff(tv: Page, phones: Page[]) {
  await expect(async () => {
    for (const phone of phones) {
      // The waiting die bobs, so it is tapped where it is rather than waited on to hold still.
      const die = phone.locator('.play__dice[data-ready]');
      if (await die.count()) await die.dispatchEvent('pointerdown');
    }
    await expect(tv.locator('.tv-roll[data-phase="won"]')).toBeVisible({ timeout: 250 });
  }).toPass({ timeout: 90_000 });
}

test('a full show from lobby to champion', async ({ browser, request }) => {
  // Every phone screen is re-measured at nine sizes along the way, which takes a while.
  test.setTimeout(FIT_SHOTS ? 400_000 : 240_000);
  // --- set up a game the way the host dashboard would
  const packs = await (await request.get('/api/packs')).json();
  const pack = await (await request.get(`/api/packs/${packs[0].id}`)).json();
  // Hand-pick the board so the run is repeatable: ordinary categories that allow steals.
  const stealable: string[] = pack.categories.filter((c: { singleAttempt?: boolean }) => !c.singleAttempt).map((c: { id: string }) => c.id);
  const picks = [stealable.slice(0, 3), [stealable[3]], null];
  const created = await request.post('/api/games', { data: { packIds: [pack.id], rules: RULES, picks } });
  expect(created.status()).toBe(201);
  const { code, hostKey } = await created.json();

  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await hostContext.addInitScript(([c, k]) => localStorage.setItem('buzzoff.hosted', JSON.stringify([{ code: c, hostKey: k, name: 'E2E Night', createdAt: Date.now() }])), [code, hostKey]);
  const host = watch(await hostContext.newPage());
  await host.goto(`/host/game/${code}`);
  await expect(host.getByRole('heading', { name: 'Waiting for players' })).toBeVisible();

  const tv = watch(await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage());
  await tv.goto(`/tv/${code}`);
  await expect(tv.getByLabel(`Room code ${code.split('').join(' ')}`)).toBeVisible();
  await snap(tv, 'tv-lobby-empty');

  // --- three friends join on their phones
  const ann = await joinAs(browser, code, 'Ann');
  const bob = await joinAs(browser, code, 'Bob');
  const cat = await joinAs(browser, code, 'Cat');
  await ann.getByRole('button', { name: 'I’m ready' }).click();
  await expect(tv.locator('.tv-lobby__players li')).toHaveCount(3);
  await expect(host.getByRole('heading', { name: '3 players in the room' })).toBeVisible();
  await snap(tv, 'tv-lobby');
  await snap(ann, 'phone-lobby');
  await snap(host, 'host-lobby');

  // The show cannot start while anyone in the room has yet to tap ready: only Ann has.
  const start = host.getByRole('button', { name: /Start the show/ });
  await expect(start).toBeDisabled();
  await expect(host.getByRole('status').filter({ hasText: 'to tap ready' })).toContainText('Waiting for Bob, Cat to tap ready');
  await host.keyboard.press('Space');
  await bob.getByRole('button', { name: 'I’m ready' }).click();
  await expect(host.getByRole('status').filter({ hasText: 'to tap ready' })).toContainText('Waiting for Cat to tap ready');
  await expect(start).toBeDisabled();
  await expect(tv.locator('.tv-lobby')).toBeVisible();
  await cat.getByRole('button', { name: 'I’m ready' }).click();
  await expect(start).toBeEnabled();
  await expect(host.getByText('to tap ready')).toHaveCount(0);
  // Un-readying locks it again until she is back.
  await cat.getByRole('button', { name: '✓ Ready' }).click();
  await expect(start).toBeDisabled();
  await cat.getByRole('button', { name: 'I’m ready' }).click();

  // --- round one
  await key(host, 'Space', /Start the show/);
  await expect(tv.locator('.tv-intro h1')).toHaveText('Board One');
  await snap(tv, 'tv-round-intro');
  await snap(cat, 'phone-round-intro');
  await key(host, 'Space', /Begin round/);

  // The first pick is rolled for. Cat taps her die; the number the server rolled lands on her phone and on the TV.
  await expect(tv.getByRole('heading', { name: 'Roll for the first pick' })).toBeVisible();
  await expect(cat.getByRole('heading', { name: 'Tap to roll' })).toBeVisible();
  await expect(host.getByRole('heading', { name: 'Waiting for 3 rolls' })).toBeVisible();
  await expect(host.locator('.hc-board__col button')).toHaveCount(0);
  await cat.locator('.play__dice').dispatchEvent('pointerdown');
  const catOnTv = tv.locator('.tv-roll__players li').filter({ hasText: 'Cat' }).locator('.bz-die');
  await expect(catOnTv).toHaveAttribute('data-face', /^[1-6]$/);
  await expect(catOnTv).not.toHaveAttribute('data-tumbling');
  await expect(cat.locator('.play__dice .bz-die')).not.toHaveAttribute('data-tumbling');
  expect(await cat.locator('.play__dice .bz-die').getAttribute('data-face')).toBe(await catOnTv.getAttribute('data-face'));
  await expect(cat.locator('.play__dice')).toBeDisabled();
  await tv.screenshot({ path: `${SHOTS}/tv-roll.png` });
  await snap(cat, 'phone-rolled');

  // Everyone else rolls (or is rolled for), ties go again by themselves, and the winner gets the board.
  await rollOff(tv, [ann, bob, cat]);
  await tv.screenshot({ path: `${SHOTS}/tv-roll-won.png` });
  const firstPick = (await tv.locator('.tv-roll__players li[data-winner] strong').innerText()).trim();
  await expect(tv.getByRole('heading', { name: `${firstPick} picks first!` })).toBeVisible();
  await expect(tv.locator('.tv-board__cell')).toHaveCount(6, { timeout: 15_000 });
  await expect(tv.locator('.tv-board__picker')).toContainText(firstPick);
  await expect(host.getByRole('heading', { name: `${firstPick} picks` })).toBeVisible();
  await snap(tv, 'tv-board');
  await snap(cat, 'phone-waiting-for-pick');
  await snap(host, 'host-board');

  // An ordinary clue: Bob buzzes first and is right.
  const plain = host.locator('.hc-board__col button:not([data-wager]):not(:disabled)').first();
  const value = Number((await plain.innerText()).replace(/\D/g, ''));
  await plain.click();
  // Selecting the clue is all it takes: buzzers are open, with thirty seconds on the clock.
  await expect(buzzer(bob)).toHaveAttribute('data-state', 'open');
  await expect(host.locator('.hc-clue__state')).toHaveText('Buzzers are open');
  await expect(host.getByRole('button', { name: /Arm buzzers|Disarm buzzers/ })).toHaveCount(0);
  const clock = host.locator('.hc-timer__count');
  expect(Number(await clock.innerText())).toBeGreaterThan(27);
  // The host can still buy time or stop the clock.
  await host.getByRole('button', { name: '+10 s' }).click();
  await expect.poll(async () => Number(await clock.innerText())).toBeGreaterThan(35);
  await host.getByRole('button', { name: 'Stop clock' }).click();
  await expect(clock).toHaveCount(0);
  await expect(buzzer(bob)).toHaveAttribute('data-state', 'open');
  await snap(tv, 'tv-buzzers-open');
  await snap(cat, 'phone-buzzer-open');
  await buzzer(bob).click();
  await expect(buzzer(bob)).toHaveAttribute('data-state', 'yours');
  await expect(buzzer(cat)).toHaveAttribute('data-state', 'taken');
  await buzzer(cat).click({ force: true }).catch(() => undefined); // a late press changes nothing
  await buzzer(ann).click({ force: true }).catch(() => undefined);
  await expect(tv.locator('.tv-answering h2')).toHaveText('Bob');
  await expect(bob.locator('.play__readout')).toContainText(/registered at [\d.]+ m?s/);
  // While Bob's answer is judged the question is off the TV and every phone; the host still has it.
  await expect(tv.locator('.tv-clue__hidden')).toHaveText('Question hidden while Bob answers');
  await expect(tv.locator('.tv-clue__q')).toHaveCount(0);
  await expect(bob.locator('.play__hidden')).toHaveText('Question hidden while you answer');
  await expect(cat.locator('.play__hidden')).toHaveText('Question hidden while Bob answers');
  await expect(host.locator('.hc-clue__q')).not.toBeEmpty();
  await snap(tv, 'tv-answering');
  await snap(bob, 'phone-won-buzz');
  await snap(cat, 'phone-beaten');
  await snap(host, 'host-judging');

  await key(host, 'c', /Correct/);
  await expect(tv.locator('.tv-result__answer')).toBeVisible();
  await expect(bob.locator('.play__score .bz-num')).toHaveText(value.toLocaleString('en-US'));
  await snap(tv, 'tv-answer-revealed');
  await snap(bob, 'phone-correct');
  await key(host, 'Space', /Back to the board/);

  // A wrong answer costs points and opens the buzzers for the others; undo puts it right.
  await host.locator('.hc-board__col button:not([data-wager]):not(:disabled)').first().click();
  await expect(buzzer(cat)).toHaveAttribute('data-state', 'open');
  // Pausing shuts the buzzers; resuming opens them again without anyone arming anything.
  await key(host, 'p', /Pause/);
  await expect(cat.getByRole('heading', { name: 'Paused' })).toBeVisible();
  await expect(host.locator('.hc-clue__state')).toHaveText('Paused — buzzers open again when you resume');
  await key(host, 'p', /Resume/);
  await expect(buzzer(cat)).toHaveAttribute('data-state', 'open');
  await buzzer(cat).click();
  await expect(buzzer(cat)).toHaveAttribute('data-state', 'yours');
  // The question timer stands still while Cat answers.
  await expect(tv.locator('.tv-clue__timer')).toHaveAttribute('data-held');
  await expect(ann.locator('.play__hidden')).toBeVisible();
  await expect(host.locator('.hc-clue__state')).toContainText('timer paused');
  await key(host, 'x', /Incorrect/);
  // Wrong: the question and the buzzers come back for the others, with the timer carrying on; Cat stays out.
  await expect(buzzer(cat)).toHaveAttribute('data-state', 'out');
  await expect(buzzer(ann)).toHaveAttribute('data-state', 'open');
  await expect(tv.locator('.tv-clue__q')).not.toBeEmpty();
  await expect(tv.locator('.tv-clue__timer')).not.toHaveAttribute('data-held');
  await expect(ann.locator('.play__clue p[data-scroll]')).not.toBeEmpty();
  const resumed = Number(await host.locator('.hc-timer__count').innerText());
  expect(resumed).toBeLessThanOrEqual(30);
  expect(resumed).toBeGreaterThan(15);
  await expect(cat.locator('.play__score .bz-num')).toHaveAttribute('data-negative', 'true');
  await key(host, 'u', /Undo/);
  await expect(buzzer(cat)).toHaveAttribute('data-state', 'yours');
  await expect(cat.locator('.play__score .bz-num')).toHaveText('0');
  await key(host, 'r', /Reveal answer/);
  await key(host, 'Space', /Back to the board/);

  // The hidden wager: Bob has the board, so the wager is his.
  await host.locator('.hc-board__col button[data-wager]').click();
  await expect(tv.locator('.tv-wager__burst')).toBeVisible();
  await expect(bob.getByLabel('Wager amount')).toBeVisible();
  await snap(tv, 'tv-wager');
  await snap(bob, 'phone-wager');
  await expectFitsWithKeyboard(bob, 'phone-wager', '.play__wager', ['.play__wagerpanel .bz-btn--primary'], FIT_SHOTS);
  await bob.getByRole('button', { name: /All in/ }).click();
  await bob.getByRole('button', { name: /Lock in/ }).click();
  await expect(tv.locator('.tv-answering h2')).toHaveText('Bob');
  await key(host, 'c', /Correct/);
  await key(host, 'Space', /Back to the board/);

  // Bob has the board. His phone shows it and tells him to call it out; only the host can select a clue.
  await expect(bob.getByRole('heading', { name: /Tell the host/ })).toBeVisible();
  await expect(bob.locator('.play__grid b')).toHaveCount(6);
  await expect(bob.locator('.play__grid b[data-used]')).toHaveCount(3);
  // Played clues stay on every board with their value, dimmed, and cannot be selected again.
  for (const used of [bob.locator('.play__grid b[data-used]'), tv.locator('.tv-board__cell[data-used]'), host.locator('.hc-board__col button[data-used]')]) {
    await expect(used).toHaveCount(3);
    for (const cell of await used.all()) await expect(cell).toHaveText(/^[\d,]+/); // the value, then the winner's avatar where there is one
  }
  for (const cell of await host.locator('.hc-board__col button[data-used]').all()) await expect(cell).toBeDisabled();
  const dimmed = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el.querySelector('.bz-num') ?? el).color);
  expect(await dimmed(tv, '.tv-board__cell[data-used]')).not.toBe(await dimmed(tv, '.tv-board__cell:not([data-used])'));
  expect(await dimmed(bob, '.play__grid b[data-used]')).not.toBe(await dimmed(bob, '.play__grid b:not([data-used])'));
  await snap(tv, 'tv-board-played');
  await snap(host, 'host-board-played');
  await expect(bob.locator('.play__grid').getByRole('button')).toHaveCount(0);
  await expect(ann.getByRole('heading', { name: 'Bob is picking' })).toBeVisible();
  await expect(host.getByText('Bob calls a category and a value; you click it.')).toBeVisible();
  await snap(bob, 'phone-pick-clue');
  host.once('dialog', (d) => d.accept());
  await host.getByRole('button', { name: 'End round' }).click();
  await expect(tv.locator('.tv-standings li')).toHaveCount(3);
  await snap(tv, 'tv-standings');
  await snap(cat, 'phone-standings');

  // --- final: everyone wagers, then writes an answer
  await key(host, 'Space', /Next:/);
  await key(host, 'Space', /Begin round/);
  await expect(cat.getByLabel('Wager amount')).toBeVisible();
  await snap(cat, 'phone-final-wager');
  for (const p of [ann, bob, cat]) {
    await expect(p.getByLabel('Wager amount')).toBeVisible();
    await p.getByRole('button', { name: /Lock in/ }).click();
  }
  await expect(tv.locator('.tv-final .tv-clue__q')).toBeVisible();
  for (const [p, text] of [[ann, 'my best guess'], [bob, 'something else'], [cat, '']] as const) {
    if (!text) continue;
    await p.getByLabel('Your answer').fill(text);
    await p.getByRole('button', { name: 'Save answer' }).click();
  }
  await snap(tv, 'tv-final-answering');
  await snap(ann, 'phone-final-answer');
  await expectFitsWithKeyboard(ann, 'phone-final-answer', '.play__fminput', ['.play__entry .bz-btn', '.play__fmq', '.play__fmclock'], FIT_SHOTS);
  await key(host, 'Space', /Pens down/);
  for (let i = 0; i < 3; i++) {
    await key(host, 'Space', /Show next answer/);
    await expect(host.getByRole('button', { name: /^Incorrect/ })).toBeVisible();
    if (i === 1) await snap(tv, 'tv-final-reveal');
    if (i === 1) await snap(cat, 'phone-final-reveal');
    if (i === 1) await snap(host, 'host-final-judging');
    await key(host, 'x', /Incorrect/);
  }
  await expect(tv.locator('.tv-result__answer')).toBeVisible();
  await key(host, 'Space', /Finish round/);
  await expect(tv.locator('.tv-standings li')).toHaveCount(3);

  // --- fast money: the top two, leader first
  await key(host, 'Space', /Next:/);
  await key(host, 'Space', /Begin round/);
  await expect(tv.locator('.tv-fm__player')).toHaveCount(2);
  const order = await tv.locator('.tv-fm__player strong').allInnerTexts();
  const byName: Record<string, Page> = { Ann: ann, Bob: bob, Cat: cat };
  const [first, second] = order.map((n) => byName[n]);

  await snap(first, 'phone-fm-up-next');
  await key(host, 'Space', /Start the clock/);
  await first.getByLabel('Your answer').fill('pizza');
  await snap(first, 'phone-fm-input');
  await expectFitsWithKeyboard(first, 'phone-fm-input', '.play__fminput', ['.play__entry .bz-btn', '.play__fmq', '.play__fmclock', '.play__pass'], FIT_SHOTS);
  await snap(tv, 'tv-fm-answering');
  await first.getByRole('button', { name: 'Submit' }).click();
  await first.getByLabel('Your answer').fill('dog');
  await first.getByRole('button', { name: 'Submit' }).click();
  await expect(first.getByRole('button', { name: 'Lock in my answers' })).toBeVisible();
  await snap(first, 'phone-fm-review');
  await first.getByRole('button', { name: 'Lock in my answers' }).click();

  await key(host, 'Space', /Start the clock/);
  await second.getByLabel('Your answer').fill('Pizza');
  await second.getByRole('button', { name: 'Submit' }).click();
  await expect(second.getByRole('alert')).toContainText('Already taken'); // no repeats
  await snap(second, 'phone-fm-duplicate');
  await second.getByLabel('Your answer').fill('coffee');
  await second.getByRole('button', { name: 'Submit' }).click();
  await second.getByRole('button', { name: 'Pass' }).click().catch(() => undefined);
  await second.getByRole('button', { name: 'Lock in my answers' }).click();

  await expect(host.getByRole('heading', { name: 'Reveal the answers' })).toBeVisible();
  await snap(host, 'host-fm-reveal');
  // Two contestants, two questions, two beats each: answer, then "survey says".
  for (let i = 0; i < 8; i++) {
    await key(host, 'Space', i % 2 ? /Survey says/ : /Show answer/);
    await expect(host.locator('.hc-fm__row[data-shown="2"]')).toHaveCount(Math.floor((i + 1) / 2));
    if (i === 2) await snap(tv, 'tv-fm-reveal');
    if (i === 2) await snap(first, 'phone-fm-reveal');
  }
  await key(host, 'Space', /Show the result/);
  await expect(tv.locator('.tv-fm[data-stage="result"]')).toBeVisible();
  await snap(tv, 'tv-fm-result');
  await key(host, 'Space', /Finish the game/);

  // --- the finish
  await expect(tv.locator('.tv-finale h1')).toBeVisible();
  await expect(tv.locator('.tv-finale__champ')).not.toHaveCount(0);
  await snap(tv, 'tv-finale');
  await snap(first, 'phone-finished');
  await snap(host, 'host-finished');

  const history = await (await request.get('/api/history')).json();
  expect(history[0]).toMatchObject({ code, name: 'E2E Night' });
  expect(history[0].players).toHaveLength(3);

  // --- the night goes on the leaderboard, and each phone is recognised as the player it was
  const standings = watch(await ann.context().newPage());
  await standings.goto('/leaderboard');
  await expect(standings.locator('.lb-row')).toHaveCount(3);
  await expect(standings.locator('.lb-list li[data-you] .lb-name strong')).toHaveText('Ann');
  await snap(standings, 'leaderboard-phone');
  await standings.getByRole('radio', { name: 'Accuracy' }).click();
  await standings.locator('.lb-list li[data-you] .lb-row').click();
  await expect(standings.getByRole('dialog', { name: 'Ann’s record' })).toContainText('E2E Night');
  await snap(standings, 'leaderboard-phone-player');
  await standings.keyboard.press('Escape');
  await expect(standings.getByRole('dialog')).toHaveCount(0);
  await standings.close();

  // --- play again: everyone lands back in the lobby with scores cleared
  await host.evaluate(([c, setup]) => localStorage.setItem(`buzzoff.setup.${c}`, setup), [code, JSON.stringify({ packIds: [packs[0].id], rules: RULES })]);
  await host.reload();
  await host.getByRole('button', { name: 'Play again' }).click();
  await expect(tv.locator('.tv-lobby__players li')).toHaveCount(3);
  await expect(ann.getByRole('heading', { name: 'You’re in!' })).toBeVisible();
});

test('a player who reloads keeps their seat, and a stranger cannot host', async ({ browser, request }) => {
  const packs = await (await request.get('/api/packs')).json();
  const { code } = await (await request.post('/api/games', { data: { packIds: [packs[0].id], rules: RULES } })).json();

  const ann = await joinAs(browser, code, 'Ann');
  await ann.reload();
  await expect(ann.getByRole('heading', { name: 'You’re in!' })).toBeVisible();
  await expect(ann.locator('.play__id strong')).toHaveText('Ann');

  // A spectator sees the game with no controls and is counted on the host console.
  const spectator = watch(await (await browser.newContext(PHONE)).newPage());
  await spectator.goto(`/watch/${code}`);
  await expect(spectator.getByText('Watching')).toBeVisible();
  await expect(spectator.getByRole('button', { name: /ready/i })).toHaveCount(0);
  await expect(spectator.locator('.play__board li')).toHaveCount(1);

  const stranger = watch(await (await browser.newContext()).newPage());
  await stranger.goto(`/host/game/${code}`);
  await expect(stranger.getByRole('heading', { name: 'This isn’t your game' })).toBeVisible();

  const lost = await (await browser.newContext(PHONE)).newPage();
  await lost.goto('/play/QQQQ');
  await expect(lost).toHaveURL(/\/join\/QQQQ$/);
  await expect(lost.locator('#room-status')).toContainText('No game with that code');
});

test('the host dashboard: create a game, edit a pack, review history and the leaderboard', async ({ browser }) => {
  const page = watch(await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage());
  await page.goto('/host');
  await snap(page, 'manage-home');

  // Creating a game takes two clicks from the dashboard.
  await page.getByRole('link', { name: /Host a game|New game/ }).first().click();
  await expect(page).toHaveURL(/\/host\/new/);
  await snap(page, 'manage-new-game');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page).toHaveURL(/\/host\/game\/[A-Z]{4}$/);
  await expect(page.getByRole('heading', { name: 'Waiting for players' })).toBeVisible();
  const code = page.url().slice(-4);

  await page.goto('/host');
  await expect(page.getByText(code).first()).toBeVisible();

  await page.goto('/host/packs');
  await expect(page.getByText('BuzzOff Starter Pack').first()).toBeVisible();
  await snap(page, 'manage-packs');
  await page.getByText('BuzzOff Starter Pack').first().click();
  await expect(page).toHaveURL(/\/host\/packs\/.+/);
  await snap(page, 'manage-pack-editor');

  await page.goto('/host/history');
  await snap(page, 'manage-history');

  // The standings, with the host's tools for saying who is who in a player's record.
  await page.getByRole('link', { name: 'Leaderboard' }).click();
  await expect(page).toHaveURL(/\/host\/leaderboard$/);
  await expect(page.locator('.lb-row')).toHaveCount(3);
  await snap(page, 'manage-leaderboard');
  await page.locator('.lb-row').first().click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Same person, counted twice?' })).toBeVisible();
  await snap(page, 'manage-leaderboard-player');
});
