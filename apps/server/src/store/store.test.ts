/**
 * What both stores promise the rest of the server. It always runs against the in-memory store.
 * Point TEST_DATABASE_URL at a Postgres whose user may create databases and it runs against the
 * real one too, in a scratch database it makes and drops again:
 *
 *   docker run --rm -d -e POSTGRES_PASSWORD=test -p 127.0.0.1:55439:5432 postgres:17-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55439/postgres npm test
 */
import { randomBytes } from 'node:crypto';
import { BUILTIN_PRESETS, createGame, type GameResult, type Pack } from '@buzzoff/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setLogLevel } from '../util';
import { MemoryStore } from './memory';
import { PostgresStore } from './postgres';
import { AUDIT_KEEP, type SavedGame, type Store } from './types';

setLogLevel('error');

type Opened = { store: Store; close: () => Promise<void> };
const kinds: [name: string, open: () => Promise<Opened>][] = [
  ['in-memory', async () => {
    const store = new MemoryStore();
    return { store, close: () => store.close() };
  }],
];
const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) {
  kinds.push(['Postgres', async () => {
    const name = `buzzoff_test_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const scratch = new URL(databaseUrl);
    scratch.pathname = `/${name}`;
    const store = new PostgresStore(scratch.toString());
    return {
      store,
      async close() {
        await store.close();
        await admin.query(`DROP DATABASE ${name}`);
        await admin.end();
      },
    };
  }]);
}

const pack = (id: string, updatedAt: number): Pack => ({
  id, title: `Pack ${id}`, description: '', author: '', createdAt: 1, updatedAt,
  categories: [{ id: 'c', title: 'Only', clues: [{ id: 'c-1', value: 100, question: 'Q?', answer: 'A', accept: ['a'] }] }],
  surveys: [{ id: 's', question: 'Name one', answers: [{ text: 'One', points: 60, aliases: [] }] }],
});
const game = (code: string, updatedAt: number): SavedGame => ({
  code,
  state: createGame({ code, rules: BUILTIN_PRESETS[0].rules, rounds: [], packTitles: ['Pack'], now: 1_000 }),
  secrets: { hostKeyHash: 'host', players: { p1: 'token' }, plays: 1, profiles: { p1: 'profile' } },
  updatedAt,
});
const result = (id: string, finishedAt: number): GameResult => ({ id, code: 'BCDF', name: 'Night', packTitles: [], startedAt: 1, finishedAt, rounds: [], players: [], teams: null });

describe.each(kinds)('the %s store', (_name, open) => {
  let store: Store;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ store, close } = await open());
    await store.init();
  }, 60_000);
  afterAll(() => close());

  it('starts a second time without redoing anything', async () => {
    await store.init();
    expect(await store.listPacks()).toEqual([]);
  });

  it('keeps a pack whole, lists the latest edit first, and says whether a delete found anything', async () => {
    await store.savePack(pack('old', 1_000));
    await store.savePack(pack('new', 2_000));
    expect(await store.getPack('old')).toEqual(pack('old', 1_000));
    expect((await store.listPacks()).map((p) => p.id)).toEqual(['new', 'old']);
    await store.savePack({ ...pack('old', 3_000), title: 'Renamed' });
    expect((await store.listPacks()).map((p) => p.title)).toEqual(['Renamed', 'Pack new']);
    expect(await store.deletePack('old')).toBe(true);
    expect(await store.deletePack('old')).toBe(false);
    expect(await store.getPack('old')).toBeNull();
  });

  it('keeps presets', async () => {
    const preset = { ...BUILTIN_PRESETS[1], id: 'custom-1', builtin: false };
    await store.savePreset(preset);
    expect(await store.listPresets()).toEqual([preset]);
    expect(await store.deletePreset('custom-1')).toBe(true);
    expect(await store.deletePreset('custom-1')).toBe(false);
  });

  it('saves a game with its credentials, the later save replacing the earlier', async () => {
    const first = game('BCDF', 5_000);
    await store.saveGame(first);
    const later = { ...first, state: { ...first.state, seq: 7 }, secrets: { ...first.secrets, plays: 2 }, updatedAt: 6_000 };
    await store.saveGame(later);
    await store.saveGame(game('GHJK', 7_000));
    const loaded = (await store.loadGames()).sort((a, b) => a.updatedAt - b.updatedAt);
    expect(loaded).toEqual([later, game('GHJK', 7_000)]);
    await store.deleteGame('BCDF');
    await store.deleteGame('GHJK');
    expect(await store.loadGames()).toEqual([]);
  });

  it('takes whatever a person can type, including what a database cannot hold', async () => {
    const odd = game('LMNP', 8_000);
    odd.state.packTitles = ['nul \u0000 and half an emoji \ud83d'];
    await store.saveGame(odd);
    const [loaded] = await store.loadGames();
    expect(loaded.state.packTitles[0]).toContain('and half an emoji');
    expect(loaded.secrets).toEqual(odd.secrets);
    await store.deleteGame('LMNP');
  });

  it('lists results newest first, every one of them or only the latest few', async () => {
    for (const [id, at] of [['a', 3_000], ['b', 1_000], ['c', 2_000]] as const) await store.saveResult(result(id, at));
    expect((await store.listResults()).map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect((await store.listResults(2)).map((r) => r.id)).toEqual(['a', 'c']);
    await store.saveResult({ ...result('b', 4_000), name: 'Replayed' });
    expect((await store.listResults(1))[0]).toMatchObject({ id: 'b', name: 'Replayed' });
    await store.deleteResult('b');
    await store.deleteResult('never-there');
    expect((await store.listResults()).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('keeps settings by name', async () => {
    expect(await store.getSetting('missing')).toBeNull();
    await store.setSetting('app', '{"a":1}');
    await store.setSetting('app', '{"a":2}');
    expect(await store.getSetting('app')).toBe('{"a":2}');
    await store.deleteSetting('app');
    expect(await store.getSetting('app')).toBeNull();
  });

  it('ends one session, every session but one, or all of them', async () => {
    const session = (tokenHash: string) => ({ tokenHash, createdAt: 10_000, expiresAt: 20_000, ip: '203.0.113.9', agent: 'Browser' });
    for (const hash of ['one', 'two', 'three']) await store.saveSession(session(hash));
    expect((await store.listSessions()).sort((a, b) => a.tokenHash.localeCompare(b.tokenHash))).toEqual([session('one'), session('three'), session('two')]);
    await store.deleteSession('two');
    await store.deleteSessions('one');
    expect(await store.listSessions()).toEqual([session('one')]);
    await store.deleteSessions();
    expect(await store.listSessions()).toEqual([]);
  });

  it('keeps the latest audit entries only, and hands them back newest first', { timeout: 60_000 }, async () => {
    for (let i = 1; i <= AUDIT_KEEP + 5; i++) await store.addAudit({ at: i, action: 'login', ip: 'server', detail: { n: i } });
    const latest = await store.listAudit(3);
    expect(latest.map((e) => e.detail.n)).toEqual([AUDIT_KEEP + 5, AUDIT_KEEP + 4, AUDIT_KEEP + 3]);
    expect(latest[0]).toMatchObject({ at: AUDIT_KEEP + 5, action: 'login', ip: 'server' });
    const everything = await store.listAudit(AUDIT_KEEP * 2);
    expect(everything).toHaveLength(AUDIT_KEEP);
    expect(everything.at(-1)!.detail.n).toBe(6);
  });
});
