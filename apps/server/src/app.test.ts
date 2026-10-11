/**
 * Integration tests: a real server on a real port, driven over HTTP and
 * WebSockets exactly as browsers drive it.
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  BUILTIN_PRESETS, DEFAULT_BUZZER,
  type Ack, type ApiError, type AuditEntry, type BuzzAck, type ClientToServerEvents, type CreateGameResponse, type GameEvent,
  type GameResult, type GameRules, type HostAction, type HostRoomView, type JoinResponse, type LeaderboardView, type NetStat,
  type PackSummary, type PlayerAction, type PlayerView, type PublicView, type Role, type ServerInfo, type ServerToClientEvents,
  type SettingsView,
} from '@buzzoff/shared';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from './app';
import { loadConfig } from './config';
import { MemoryStore } from './store/memory';
import type { Store } from './store/types';
import { setLogLevel } from './util';

setLogLevel('error');

const RULES: GameRules = {
  name: 'Test Night',
  rounds: [{ mode: 'trivia', title: 'Board', categories: 2, cluesPerCategory: 2, valueMultiplier: 1, wagers: 0, wagerCap: 1000, eliminateLowest: 0 }],
  buzzer: { ...DEFAULT_BUZZER, buzzSec: 0, answerSec: 0 },
  teams: { enabled: false, names: ['A', 'B'] },
  lateJoin: true,
  maxPlayers: 30,
};
const AVATAR = { emoji: '🐝', color: '#FFC400' };

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

class Client {
  pub!: PublicView;
  hostView: HostRoomView | null = null;
  you: PlayerView | null = null;
  net: Record<string, NetStat> = {};
  events: GameEvent[] = [];
  bye: string | null = null;
  private n = 0;
  constructor(public socket: ClientSocket) {
    socket.on('state', (v) => (this.pub = v));
    socket.on('host', (v) => (this.hostView = v));
    socket.on('you', (v) => (this.you = v));
    socket.on('event', (e) => this.events.push(e));
    socket.on('net', (n) => Object.assign(this.net, n));
    socket.on('probe', (ack) => ack());
    socket.on('bye', (reason) => (this.bye = reason));
  }
  host(action: HostAction, id = `h${this.socket.id}${this.n++}`) {
    return this.socket.emitWithAck('host:action', { id, action });
  }
  act(action: PlayerAction, id = `p${this.socket.id}${this.n++}`) {
    return this.socket.emitWithAck('player:action', { id, action });
  }
  buzz(): Promise<Ack<BuzzAck>> {
    return this.socket.emitWithAck('buzz');
  }
}

/** Poll until a condition holds; state arrives asynchronously over the socket. The condition may itself ask the server. */
async function until(condition: () => unknown, what = 'condition', timeoutMs = 3000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

class Harness {
  app!: App;
  url = '';
  clients: Client[] = [];

  async start(store: Store = new MemoryStore(), env: Record<string, string> = {}) {
    this.app = await createApp(loadConfig({ WEB_DIR: '/nonexistent', MEDIA_DIR: '/tmp/buzzoff-test-media', ...env }), store);
    await new Promise<void>((resolve) => this.app.server.listen(0, resolve));
    this.url = `http://127.0.0.1:${(this.app.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop() {
    for (const c of this.clients) c.socket.disconnect();
    this.clients = [];
    await this.app.close();
  }
  async api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; cookie: string | null }> {
    const res = await fetch(`${this.url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // What a browser would send back: the cookie the reply set, if it set one.
    const cookie = res.headers.getSetCookie()[0]?.split(';')[0] ?? null;
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as T, cookie };
  }
  async createGame(rules: GameRules = RULES, headers: Record<string, string> = {}) {
    const packs = await this.api<PackSummary[]>('GET', '/packs', undefined, headers);
    const res = await this.api<CreateGameResponse>('POST', '/games', { packIds: [packs.body[0].id], rules }, headers);
    expect(res.status).toBe(201);
    return res.body;
  }
  connect(role: Role, code: string, token?: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket: ClientSocket = io(this.url, { transports: ['websocket'], auth: { role, code, token }, reconnection: false });
      const client = new Client(socket);
      socket.on('connect_error', (err) => reject(err));
      socket.once('state', () => {
        this.clients.push(client);
        resolve(client);
      });
    });
  }
  /** `cookie` is what the joining phone already holds: pass one a previous join returned to come back as the same person. */
  async join(code: string, name: string, ready = true, cookie?: string) {
    const res = await this.api<JoinResponse>('POST', `/games/${code}/join`, { name, avatar: AVATAR }, cookie ? { cookie } : {});
    if (res.body.status !== 'joined') throw new Error(`could not join: ${JSON.stringify(res.body)}`);
    const { playerId, token } = res.body;
    const client = await this.connect('player', code, token);
    // The show cannot start until everyone in the room has tapped ready.
    if (ready) await client.act({ t: 'ready', ready: true });
    return { playerId, token, client, cookie: res.cookie! };
  }
}

let h: Harness;
afterEach(async () => h?.stop());

/** Play the roll for the first pick over the wire, tie-breaks included, the way phones do: by asking to roll. */
async function rollOff(watcher: Client, players: { client: Client; playerId: string }[]) {
  const trivia = () => (watcher.pub.round?.mode === 'trivia' ? watcher.pub.round : null);
  await until(() => trivia()?.stage === 'roll', 'the roll to start');
  while (trivia()?.stage === 'roll') {
    const roll = trivia()!.roll!;
    const due = players.filter((p) => roll.phase === 'rolling' && roll.contenders.includes(p.playerId) && roll.rolls[p.playerId] === undefined);
    await Promise.all(due.map((p) => p.client.act({ t: 'roll' })));
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('a game over the wire', () => {
  it('plays a clue end to end and keeps every screen in sync', { timeout: 60_000 }, async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);

    const host = await h.connect('host', code, hostKey);
    const tv = await h.connect('display', code);
    const ann = await h.join(code, 'Ann');
    const bob = await h.join(code, 'Bob', false);
    await until(() => tv.pub.players.filter((p) => p.connected).length === 2, 'both players online');
    expect(host.hostView!.audience).toEqual({ displays: 1, spectators: 0 });

    // The show waits for everyone in the room: Bob has not tapped ready.
    expect(await host.host({ t: 'start' })).toEqual({ ok: false, error: { code: 'not_ready', message: 'Waiting for Bob to tap ready' } });
    expect(tv.pub.phase).toBe('lobby');
    await bob.client.act({ t: 'ready', ready: true });
    expect(await host.host({ t: 'start' })).toEqual({ ok: true });
    await host.host({ t: 'round.begin' });

    // The first pick is rolled for. Phones only ask to roll; the number is the server's.
    await until(() => tv.pub.round?.mode === 'trivia' && tv.pub.round.stage === 'roll', 'the roll to start');
    expect(await host.host({ t: 'clue.select', cat: 0, idx: 0 })).toMatchObject({ ok: false, error: { code: 'bad_stage' } });
    await expect(tv.socket.timeout(300).emitWithAck('player:action', { id: 'tv-roll', action: { t: 'roll' } })).rejects.toThrow();
    await rollOff(tv, [ann, bob]);
    const rolled = tv.events.filter((e) => e.type === 'dice.rolled');
    expect(rolled.length).toBeGreaterThanOrEqual(2);
    for (const e of rolled) expect([1, 2, 3, 4, 5, 6]).toContain(e.value);
    const won = tv.events.find((e) => e.type === 'dice.won')!;
    expect(tv.pub.round).toMatchObject({ stage: 'board', controlId: won.playerId, roll: null });
    // Whoever won out-rolled the other in the deciding round.
    const [mine, theirs] = [rolled.findLast((e) => e.playerId === won.playerId)!, rolled.findLast((e) => e.playerId !== won.playerId)!];
    expect(mine.value).toBeGreaterThan(theirs.value);

    await host.host({ t: 'clue.select', cat: 0, idx: 0 });
    await until(() => ann.client.you?.buzzer.state === 'open', 'buzzers open on selection');
    const question = tv.pub.round!.mode === 'trivia' ? tv.pub.round!.clue!.question : null;
    expect(question).toBeTruthy();
    expect(await host.host({ t: 'buzz.close' } as unknown as HostAction)).toMatchObject({ ok: false, error: { code: 'invalid' } });

    const first = await ann.client.buzz();
    const second = await bob.client.buzz();
    expect(first).toMatchObject({ ok: true, data: { status: 'registered' } });
    expect(second).toMatchObject({ ok: true, data: { status: 'registered' } });
    await until(() => tv.pub.round?.mode === 'trivia' && tv.pub.round.clue?.attempts.length === 2, 'both buzzes shown');

    const clue = tv.pub.round!.mode === 'trivia' ? tv.pub.round!.clue! : null;
    expect(clue!.answererId).toBe(ann.playerId);
    expect(clue!.attempts[0]).toMatchObject({ playerId: ann.playerId, winner: true, deltaMs: 0 });
    expect(clue!.attempts[1].deltaMs).toBeGreaterThan(0);
    expect(clue!.answer).toBeNull();
    expect(bob.client.you!.buzzer).toMatchObject({ state: 'taken', rank: 2 });
    // While Ann's answer is judged the question is gone from every screen but the host's.
    expect(clue!.question).toBeNull();
    for (const view of [tv.pub, ann.client.pub, bob.client.pub]) expect(JSON.stringify(view)).not.toContain(question!);
    // The answer is on the host's screen and nowhere else.
    const secret = host.hostView!.round!.mode === 'trivia' ? host.hostView!.round! : null;
    expect(secret!.clue).toMatchObject({ question });
    expect(secret!.clue!.answer).toBeTruthy();
    for (const view of [tv.pub, ann.client.pub, bob.client.pub, ann.client.you]) {
      expect(JSON.stringify(view)).not.toMatch(/"accept"|"notes"|"answer":"/);
    }

    await host.host({ t: 'judge', correct: true });
    await until(() => tv.pub.players[0].score === clue!.value, 'score update');
    expect(tv.events.map((e) => e.type)).toEqual(expect.arrayContaining(['game.started', 'buzz.open', 'buzz.winner', 'judged', 'clue.result']));
    expect(host.hostView!.undo).toBe('ruling');

    await host.host({ t: 'undo' });
    await until(() => tv.pub.players[0].score === 0, 'undo');
    expect(tv.pub.round!.mode === 'trivia' && tv.pub.round!.clue!.stage).toBe('answering');
  });

  it('picks exactly one winner when many players buzz at once', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const players = await Promise.all(Array.from({ length: 12 }, (_, i) => h.join(code, `P${i}`)));
    await host.host({ t: 'start' });
    await host.host({ t: 'round.begin' });
    // Skip the roll for the first pick: handing someone the board ends it.
    await host.host({ t: 'control.set', id: players[0].playerId });
    await host.host({ t: 'clue.select', cat: 0, idx: 0 });

    // Everyone buzzes three times in the same tick.
    const acks = await Promise.all(players.flatMap((p) => [p.client.buzz(), p.client.buzz(), p.client.buzz()]));
    const statuses = acks.map((a) => (a.ok ? a.data.status : 'error'));
    expect(statuses.filter((s) => s === 'registered')).toHaveLength(12);
    expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(24);

    await until(() => host.pub.round?.mode === 'trivia' && host.pub.round.clue?.attempts.length === 12, 'all attempts');
    const attempts = host.pub.round!.mode === 'trivia' ? host.pub.round!.clue!.attempts : [];
    expect(attempts.filter((a) => a.winner)).toHaveLength(1);
    expect(new Set(attempts.map((a) => a.playerId)).size).toBe(12);
    // Listed in the order the server received them.
    expect(attempts.map((a) => a.ms)).toEqual([...attempts.map((a) => a.ms)].sort((a, b) => a - b));
    expect(attempts[0].deltaMs).toBe(0);
  });

  it('applies a repeated message only once', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    const adjust: HostAction = { t: 'score.adjust', id: ann.playerId, delta: 100 };
    await Promise.all([host.host(adjust, 'same-id'), host.host(adjust, 'same-id'), host.host(adjust, 'same-id')]);
    await host.host(adjust, 'another-id');
    await until(() => host.pub.players[0].score > 0);
    expect(host.pub.players[0].score).toBe(200);
  });

  it('answers a retried message that was rejected with the same rejection', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const first = await host.host({ t: 'judge', correct: true }, 'rejected-id');
    const retry = await host.host({ t: 'judge', correct: true }, 'rejected-id');
    expect(first.ok).toBe(false);
    expect(retry).toEqual(first);
  });

  it('sounds the repeated-answer buzzer for a repeated Fast Money answer and for nothing else', async () => {
    h = await new Harness().start();
    // A second roll is refused as a duplicate too, but that is no business of the room's.
    const board = await h.createGame();
    const host = await h.connect('host', board.code, board.hostKey);
    const tv = await h.connect('display', board.code);
    const ann = await h.join(board.code, 'Ann');
    await h.join(board.code, 'Bob');
    await host.host({ t: 'start' });
    await host.host({ t: 'round.begin' });
    expect(await ann.client.act({ t: 'roll' })).toEqual({ ok: true });
    expect(await ann.client.act({ t: 'roll' })).toMatchObject({ ok: false, error: { code: 'duplicate' } });
    await host.host({ t: 'cue', name: 'tada' });
    await until(() => tv.events.some((e) => e.type === 'cue'), 'everything sent before the cue');
    expect(tv.events.map((e) => e.type)).not.toContain('fm.duplicate');

    const survey = await h.createGame({
      ...RULES,
      rounds: [{
        mode: 'fastMoney', title: 'Fast Money', questions: 2, participants: 'top2', turnSec: 60, extraSecPerTurn: 0,
        blockDuplicates: true, reveal: 'atEnd', stakes: 'points', pointMultiplier: 1, target: 0, targetBonus: 0,
      }],
    });
    const host2 = await h.connect('host', survey.code, survey.hostKey);
    const tv2 = await h.connect('display', survey.code);
    const seats = [await h.join(survey.code, 'Cat'), await h.join(survey.code, 'Dan')];
    await host2.host({ t: 'start' });
    await host2.host({ t: 'round.begin' });
    await until(() => tv2.pub.round?.mode === 'fastMoney' && tv2.pub.round.stage === 'ready', 'the first turn');
    const turns = tv2.pub.round!.mode === 'fastMoney' ? tv2.pub.round!.turns : [];
    const [first, second] = turns.map(([id]) => seats.find((s) => s.playerId === id)!);
    await host2.host({ t: 'fm.start' });
    expect(await first.client.act({ t: 'fm.answer', q: 0, text: 'Zebra' })).toEqual({ ok: true });
    await first.client.act({ t: 'fm.done' });
    await host2.host({ t: 'fm.start' });
    expect(await second.client.act({ t: 'fm.answer', q: 0, text: 'zebras' })).toMatchObject({ ok: false, error: { code: 'duplicate' } });
    await until(() => tv2.events.some((e) => e.type === 'fm.duplicate'), 'the buzzer');
    expect(tv2.events.find((e) => e.type === 'fm.duplicate')).toEqual({ type: 'fm.duplicate', playerId: second.playerId });
  });

  it('does not let two people who pick the same name at once share a seat', async () => {
    h = await new Harness().start();
    const { code } = await h.createGame();
    const join = () => h.api<JoinResponse>('POST', `/games/${code}/join`, { name: 'Sam', avatar: AVATAR });
    const [first, second] = [await join(), await join()];
    expect(first.body.status).toBe('joined');
    expect(second.status).toBe(409);
    if (first.body.status !== 'joined') throw new Error('expected a seat');
    await h.connect('player', code, first.body.token);
  });

  it('leaves Socket.IO its own path and answers bad uploads and ranges with the right status', async () => {
    h = await new Harness().start();
    expect((await fetch(`${h.url}/socket.io/?EIO=4&transport=polling`)).status).toBe(400);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')]), 'dot.png');
    const upload = await fetch(`${h.url}/api/media`, { method: 'POST', body: form });
    const { url } = (await upload.json()) as { url: string };
    expect((await fetch(h.url + url, { headers: { range: 'bytes=9999-' } })).status).toBe(416);

    const heic = new FormData();
    heic.append('file', new Blob([Buffer.from('00000018667479706865696300000000', 'hex')]), 'photo.mp4');
    expect((await fetch(`${h.url}/api/media`, { method: 'POST', body: heic })).status).toBe(409);
    const stray = new FormData();
    stray.append('wrong-field', new Blob(['x']), 'x.png');
    expect((await fetch(`${h.url}/api/media`, { method: 'POST', body: stray })).status).toBe(400);
  });

  it('measures round-trip time on the server and reports it', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    await until(() => ann.client.net[ann.playerId], 'own latency');
    expect(ann.client.net[ann.playerId].rttMs).toBeGreaterThanOrEqual(0);
    expect(ann.client.net[ann.playerId].rttMs).toBeLessThan(500);
    await until(() => host.net[ann.playerId], 'host sees latency', 5000);
  });
});

describe('authorisation', () => {
  it('rejects forged roles, wrong keys and malformed input', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const ann = await h.join(code, 'Ann');
    const tv = await h.connect('display', code);

    await expect(h.connect('host', code, 'not-the-key')).rejects.toThrow('unauthorized');
    await expect(h.connect('host', code, ann.token)).rejects.toThrow('unauthorized');
    await expect(h.connect('player', code, hostKey)).rejects.toThrow('unauthorized');
    await expect(h.connect('display', 'QQQQ')).rejects.toThrow('no_room');

    // A player or display that sends host events is simply not listened to.
    const forged = ann.client.socket.timeout(300).emitWithAck('host:action', { id: 'x', action: { t: 'score.set', id: ann.playerId, score: 999999 } });
    await expect(forged).rejects.toThrow();
    await expect(tv.socket.timeout(300).emitWithAck('buzz')).rejects.toThrow();

    const host = await h.connect('host', code, hostKey);
    // Only the host can put a clue in play; a player asking for one is not understood, whoever has the board.
    await host.host({ t: 'start' });
    await host.host({ t: 'round.begin' });
    await host.host({ t: 'control.set', id: ann.playerId });
    expect(await ann.client.act({ t: 'select', cat: 0, idx: 0 } as unknown as PlayerAction)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(host.pub.round).toMatchObject({ stage: 'board', clue: null });

    expect(await host.host({ t: 'score.adjust', id: ann.playerId, delta: 1.5 } as HostAction)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await host.host({ t: 'made.up' } as unknown as HostAction)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await host.host({ t: 'judge', correct: true })).toMatchObject({ ok: false, error: { code: 'no_clue' } });
    expect(host.pub.players[0].score).toBe(0);

    expect((await h.api('GET', `/games/${code}/host`, undefined, { 'x-host-key': 'nope' })).status).toBe(403);
    expect((await h.api('GET', `/games/${code}/host`, undefined, { 'x-host-key': hostKey })).status).toBe(200);
    expect((await h.api('POST', `/games/${code}/join`, { name: '', avatar: AVATAR })).status).toBe(400);
    expect((await h.api('POST', `/games/${code}/join`, { name: 'Zed', avatar: { emoji: '<script>', color: 'red' } })).status).toBe(400);
    expect((await h.api('POST', `/games/${code}/join`, { name: 'ann', avatar: AVATAR })).status).toBe(409);
  });

  it('tells browsers and proxies never to keep an API answer, and what a page may load', async () => {
    h = await new Harness().start();
    for (const path of ['/api/info', '/api/packs', '/api/games/QQQQ', '/api/nowhere']) {
      expect([path, (await fetch(h.url + path)).headers.get('cache-control')]).toEqual([path, 'no-store']);
    }
    const policy = (await fetch(`${h.url}/api/info`)).headers.get('content-security-policy')!;
    for (const rule of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"]) expect(policy).toContain(rule);
    expect(policy).not.toMatch(/script-src|unsafe-eval/);
  });

  it('guards hosting and content behind the admin password when one is set', async () => {
    h = await new Harness().start(new MemoryStore(), { BUZZOFF_ADMIN_PASSWORD: 'hunter2' });
    expect((await h.api('GET', '/packs')).status).toBe(401);
    expect((await h.api('POST', '/games', { packIds: ['x'], rules: RULES })).status).toBe(401);
    expect((await h.api('POST', '/auth/login', { password: 'wrong' })).status).toBe(401);
    const login = await h.api<{ token: string }>('POST', '/auth/login', { password: 'hunter2' });
    expect(login.status).toBe(200);
    const auth = { authorization: `Bearer ${login.body.token}` };
    expect((await h.api('GET', '/packs', undefined, { authorization: 'Bearer 9999999999999.forged' })).status).toBe(401);
    const { code } = await h.createGame(RULES, auth);
    // Players never need the password.
    await h.join(code, 'Ann');
  });

  it('throttles repeated password guesses', async () => {
    h = await new Harness().start(new MemoryStore(), { BUZZOFF_ADMIN_PASSWORD: 'hunter2' });
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await h.api('POST', '/auth/login', { password: `guess${i}` })).status);
    expect(statuses.slice(0, 6)).toEqual(Array(6).fill(401));
    expect(statuses.slice(6)).toEqual(Array(4).fill(429));
  });
});

describe('settings and sign-in', () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const login = (password: string) => h.api<{ token: string }>('POST', '/auth/login', { password });

  it('imports the old environment settings once, after which the database is in charge', async () => {
    const store = new MemoryStore();
    const env = { BUZZOFF_ADMIN_PASSWORD: 'hunter2', PUBLIC_URL: 'https://buzz.example.com/', ROOM_TTL_HOURS: '2', MAX_UPLOAD_MB: '10' };
    h = await new Harness().start(store, env);
    expect((await h.api<ServerInfo>('GET', '/info')).body).toMatchObject({ authRequired: true, publicUrl: 'https://buzz.example.com' });
    const { token } = (await login('hunter2')).body;
    const view = await h.api<SettingsView>('GET', '/settings', undefined, bearer(token));
    expect(view.body.settings).toMatchObject({ roomTtlHours: 2, finishedTtlHours: 2, maxUploadMb: 10, sessionDays: 30 });
    const { code } = await h.createGame(RULES, bearer(token));
    await h.stop();

    // The environment says something else now; nobody is listening to it any more.
    const [saved] = await store.loadGames();
    await store.saveGame({ ...saved, updatedAt: Date.now() - 3 * 3_600_000 });
    h = await new Harness().start(store, { BUZZOFF_ADMIN_PASSWORD: 'something-else', PUBLIC_URL: 'https://other.example', ROOM_TTL_HOURS: '500' });
    expect((await h.api<ServerInfo>('GET', '/info')).body.publicUrl).toBe('https://buzz.example.com');
    expect((await login('something-else')).status).toBe(401);
    // The session outlived the restart, and the game idle for longer than the saved two hours did not.
    expect((await h.api('GET', '/packs', undefined, bearer(token))).status).toBe(200);
    expect((await h.api('GET', `/games/${code}`)).status).toBe(404);

    const [session] = await store.listSessions();
    await store.saveSession({ ...session, expiresAt: Date.now() - 1 });
    await h.stop();
    h = await new Harness().start(store);
    expect((await h.api('GET', '/packs', undefined, bearer(token))).status).toBe(401);
  });

  it('applies changes at once, validates them, and turns away anyone who is not signed in', async () => {
    h = await new Harness().start(new MemoryStore(), { BUZZOFF_ADMIN_PASSWORD: 'hunter2' });
    for (const [method, path] of [['GET', '/settings'], ['PUT', '/settings'], ['GET', '/audit'], ['POST', '/auth/password'], ['POST', '/auth/sessions/revoke']]) {
      expect((await h.api(method, path, method === 'GET' ? undefined : {})).status).toBe(401);
    }
    const auth = bearer((await login('hunter2')).body.token);
    const { settings } = (await h.api<SettingsView>('GET', '/settings', undefined, auth)).body;

    for (const bad of [
      { publicUrl: 'javascript:alert(1)' }, { publicUrl: 'https://buzz.example.com/some/path' }, { publicUrl: 'https://user:pw@buzz.example.com' },
      { roomTtlHours: 0 }, { maxUploadMb: 9999 }, { sessionDays: 1.5 }, { defaultPresetId: 'no-such-format' },
    ]) {
      expect((await h.api('PUT', '/settings', { ...settings, ...bad }, auth)).status).toBe(400);
    }
    const next = { ...settings, publicUrl: 'http://192.168.1.50:3210', defaultPresetId: 'full-show', maxUploadMb: 1, sessionDays: 7 };
    expect((await h.api('PUT', '/settings', next, auth)).status).toBe(200);
    expect((await h.api<ServerInfo>('GET', '/info')).body).toMatchObject({ publicUrl: 'http://192.168.1.50:3210', defaultPresetId: 'full-show' });

    const big = new FormData();
    big.append('file', new Blob([Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1_500_000)])]), 'big.png');
    const upload = await fetch(`${h.url}/api/media`, { method: 'POST', body: big, headers: auth });
    expect(upload.status).toBe(413);
    expect(((await upload.json()) as ApiError).error.message).toContain('1 MB');

    expect((await h.api('POST', '/auth/password', { current: 'hunter2', next: 'short' }, auth)).status).toBe(400);
    await login('hunter2');
    const { sessions } = (await h.api<SettingsView>('GET', '/settings', undefined, auth)).body;
    expect(sessions.map((s) => s.current)).toEqual([false, true]);
    expect(sessions[0].expiresAt - sessions[0].createdAt).toBe(7 * 24 * 3_600_000);

    const log = (await h.api<AuditEntry[]>('GET', '/audit', undefined, auth)).body;
    expect(log.find((e) => e.action === 'settings.changed')!.detail).toEqual({
      changes: {
        publicUrl: { from: null, to: 'http://192.168.1.50:3210' }, defaultPresetId: { from: null, to: 'full-show' },
        maxUploadMb: { from: 25, to: 1 }, sessionDays: { from: 30, to: 7 },
      },
    });
  });

  it('sets, changes and protects the password, storing nothing that could be used to sign in', async () => {
    const store = new MemoryStore();
    h = await new Harness().start(store);
    expect((await h.api<SettingsView>('GET', '/settings')).body.passwordSet).toBe(false);

    const first = (await h.api<{ token: string }>('POST', '/auth/password', { next: 'correct horse' })).body.token;
    expect((await h.api<ServerInfo>('GET', '/info')).body.authRequired).toBe(true);
    expect((await h.api('GET', '/packs')).status).toBe(401);
    expect((await h.api('GET', '/packs', undefined, bearer(first))).status).toBe(200);
    const second = (await login('correct horse')).body.token;

    // Being signed in is not enough to change the password.
    expect((await h.api('POST', '/auth/password', { next: 'battery staple' }, bearer(first))).status).toBe(403);
    const changed = await h.api<{ token: string }>('POST', '/auth/password', { current: 'correct horse', next: 'battery staple' }, bearer(first));
    expect(changed.status).toBe(200);
    const third = changed.body.token;
    for (const token of [first, second]) expect((await h.api('GET', '/packs', undefined, bearer(token))).status).toBe(401);
    expect((await login('correct horse')).status).toBe(401);
    const fourth = (await login('battery staple')).body.token;

    expect((await h.api('POST', '/auth/sessions/revoke', {}, bearer(third))).body).toEqual({ ended: 1 });
    expect((await h.api('GET', '/packs', undefined, bearer(fourth))).status).toBe(401);

    const log = (await h.api<AuditEntry[]>('GET', '/audit', undefined, bearer(third))).body;
    expect(log.map((e) => e.action)).toEqual(['sessions.revoked', 'login', 'login.failed', 'password.changed', 'login.failed', 'login', 'password.set']);
    const everythingSaved = JSON.stringify([log, await store.listSessions(), await store.getSetting('admin_password'), await store.getSetting('app')]);
    for (const secret of ['correct horse', 'battery staple', first, second, third, fourth]) expect(everythingSaved).not.toContain(secret);
    expect(await store.getSetting('admin_password')).toMatch(/^scrypt\$15\$8\$1\$/);
    expect(JSON.stringify((await h.api('GET', '/settings', undefined, bearer(third))).body)).not.toContain('scrypt');

    expect((await h.api('POST', '/auth/logout', {}, bearer(third))).status).toBe(204);
    expect((await h.api('GET', '/packs', undefined, bearer(third))).status).toBe(401);
  });
});

describe('reconnection and recovery', () => {
  it('lets a player drop and come back as themselves', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    await host.host({ t: 'score.adjust', id: ann.playerId, delta: 300 });

    ann.client.socket.disconnect();
    await until(() => host.pub.players[0].connected === false, 'offline');
    const back = await h.connect('player', code, ann.token);
    await until(() => host.pub.players[0].connected === true && back.you, 'online again');
    expect(back.you!.id).toBe(ann.playerId);
    expect(host.pub.players).toHaveLength(1);
    expect(host.pub.players[0].score).toBe(300);

    // A second connection with the same token takes over; the first is told why.
    const second = await h.connect('player', code, ann.token);
    await until(() => back.bye === 'replaced', 'old tab replaced');
    await until(() => second.you);
    expect(host.pub.players[0].connected).toBe(true);
  });

  it('asks the host before handing a disconnected player to someone new mid-game', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    await h.join(code, 'Bob');
    await host.host({ t: 'start' });
    await host.host({ t: 'score.adjust', id: ann.playerId, delta: 500 });
    ann.client.socket.disconnect();
    await until(() => host.pub.players[0].connected === false);

    const request = await h.api<JoinResponse>('POST', `/games/${code}/join`, { name: 'ann', avatar: AVATAR });
    if (request.body.status !== 'pending') throw new Error('expected a pending claim');
    const { claimId, claimSecret } = request.body;
    await until(() => host.hostView!.claims.length === 1, 'claim shown to host');
    const statusUrl = `/games/${code}/claims/${claimId}?secret=${claimSecret}`;
    expect((await h.api('GET', statusUrl)).body).toEqual({ status: 'pending' });
    expect((await h.api('GET', `/games/${code}/claims/${claimId}?secret=wrong`)).status).toBe(404);

    await host.host({ t: 'claim.resolve', claimId, approve: true });
    const approved = (await h.api<{ status: string; playerId: string; token: string }>('GET', statusUrl)).body;
    expect(approved).toMatchObject({ status: 'approved', playerId: ann.playerId });
    // The old phone's token no longer works; the new one does.
    await expect(h.connect('player', code, ann.token)).rejects.toThrow('unauthorized');
    const back = await h.connect('player', code, approved.token);
    await until(() => back.you);
    expect(host.pub.players[0].score).toBe(500);
  });

  it('kicks a player for good', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    await host.host({ t: 'player.kick', id: ann.playerId });
    await until(() => ann.client.bye === 'kicked');
    await expect(h.connect('player', code, ann.token)).rejects.toThrow('unauthorized');
    expect(host.pub.players).toHaveLength(0);
  });

  it('survives a server restart with scores, credentials and a paused game', async () => {
    const store = new MemoryStore();
    h = await new Harness().start(store);
    const { code, hostKey } = await h.createGame({ ...RULES, buzzer: { ...RULES.buzzer, answerSec: 30 } });
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    await host.host({ t: 'start' });
    await host.host({ t: 'round.begin' });
    await host.host({ t: 'score.adjust', id: ann.playerId, delta: 700 });
    await host.host({ t: 'clue.select', cat: 1, idx: 1 });
    await ann.client.buzz();
    await h.stop();

    h = await new Harness().start(store);
    const host2 = await h.connect('host', code, hostKey);
    expect(host2.pub).toMatchObject({ phase: 'round', paused: true });
    expect(host2.pub.players[0]).toMatchObject({ name: 'Ann', score: 700, connected: false });
    const clue = host2.pub.round!.mode === 'trivia' ? host2.pub.round!.clue! : null;
    expect(clue).toMatchObject({ cat: 1, idx: 1, stage: 'answering', answererId: ann.playerId });

    const ann2 = await h.connect('player', code, ann.token);
    await until(() => host2.pub.players[0].connected);
    await host2.host({ t: 'pause', paused: false });
    await host2.host({ t: 'judge', correct: true });
    await until(() => ann2.pub.players[0].score > 700, 'play continues');
  });
});

describe('content and results', () => {
  it('ships a starter pack big enough for every built-in preset', async () => {
    h = await new Harness().start();
    const packs = (await h.api<PackSummary[]>('GET', '/packs')).body;
    expect(packs).toHaveLength(1);
    for (const preset of BUILTIN_PRESETS) {
      const res = await h.api('POST', '/games', { packIds: [packs[0].id], rules: preset.rules });
      expect([preset.name, res.status]).toEqual([preset.name, 201]);
    }
  });

  it('round-trips a pack through export and import, and rejects junk', async () => {
    h = await new Harness().start();
    const [starter] = (await h.api<PackSummary[]>('GET', '/packs')).body;
    const exported = (await h.api<{ format: string; pack: { title: string } }>('GET', `/packs/${starter.id}/export`)).body;
    expect(exported.format).toBe('buzzoff.pack');
    const imported = await h.api<{ id: string }>('POST', '/packs/import', { ...exported, pack: { ...exported.pack, title: 'Copy' } });
    expect(imported.status).toBe(201);
    expect((await h.api<PackSummary[]>('GET', '/packs')).body.map((p) => p.clueCount)).toEqual([70, 70]);
    expect((await h.api('POST', '/packs/import', { format: 'something.else', pack: {} })).status).toBe(400);
    expect((await h.api('DELETE', `/packs/${imported.body.id}`)).status).toBe(204);
    expect((await h.api('DELETE', `/packs/${imported.body.id}`)).status).toBe(404);
  });

  it('imports the pack that ships with BuzzOff and deals a board with one clue at each value', async () => {
    h = await new Harness().start();
    const file = JSON.parse(readFileSync(path.resolve(__dirname, '../../../packs/buzzoff-the-lot.buzzoff.json'), 'utf8'));
    const imported = await h.api<{ id: string; categories: { clues: unknown[] }[]; surveys: unknown[] }>('POST', '/packs/import', file);
    expect(imported.status).toBe(201);
    expect(imported.body.categories.length).toBeGreaterThan(100);
    expect(imported.body.categories.some((c) => c.clues.length >= 20)).toBe(true);

    const titles: string[][] = [];
    for (let game = 0; game < 2; game++) {
      const made = await h.api<CreateGameResponse>('POST', '/games', { packIds: [imported.body.id], rules: BUILTIN_PRESETS[0].rules });
      expect(made.status).toBe(201);
      const host = await h.connect('host', made.body.code, made.body.hostKey);
      await h.join(made.body.code, 'Ann');
      await host.host({ t: 'start' });
      await until(() => host.pub.round?.mode === 'trivia', 'the first board');
      const board = host.pub.round!.mode === 'trivia' ? host.pub.round!.board : [];
      expect(board.map((cat) => cat.clues.map((c) => c.value))).toEqual(Array(5).fill([100, 200, 300, 400, 500]));
      titles.push(board.map((cat) => cat.title));
      // Play a clue from each category, so that the next game knows they have been used.
      await host.host({ t: 'round.begin' });
      for (const cat of board.keys()) {
        await host.host({ t: 'clue.select', cat, idx: 0 });
        await host.host({ t: 'clue.reveal' });
        await host.host({ t: 'clue.continue' });
      }
      await host.host({ t: 'game.end' });
      await until(() => host.pub.phase === 'finished');
    }
    expect(titles[1].filter((title) => titles[0].includes(title))).toEqual([]);
  });

  it('explains when a pack is too small for the chosen rules', async () => {
    h = await new Harness().start();
    const small = await h.api<{ id: string }>('POST', '/packs', {
      title: 'Tiny',
      categories: [{ id: 'c', title: 'Only one', clues: [{ id: 'c1', value: 100, question: 'Q?', answer: 'A' }] }],
    });
    const res = await h.api<{ error: { message: string } }>('POST', '/games', { packIds: [small.body.id], rules: RULES });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/short by 1 category/);
  });

  it('lets the host swap a category for another before the round begins, and undo it', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    await h.join(code, 'Ann');
    const board = () => (host.pub.round?.mode === 'trivia' ? host.pub.round.board.map((c) => c.title) : []);
    const key = { 'x-host-key': hostKey };
    // Not in the lobby, and not by anyone but the host.
    expect((await h.api('POST', `/games/${code}/reroll`, { cat: 0 }, key)).status).toBe(409);
    await host.host({ t: 'start' });
    await until(() => board().length > 0, 'the round intro');
    const before = board();
    expect((await h.api('POST', `/games/${code}/reroll`, { cat: 0 })).status).toBe(403);
    expect((await h.api('POST', `/games/${code}/reroll`, { cat: 99 }, key)).status).toBe(400);

    expect((await h.api('POST', `/games/${code}/reroll`, { cat: 1 }, key)).status).toBe(200);
    await until(() => board()[1] !== before[1], 'the new category');
    expect(board().filter((title, i) => i !== 1)).toEqual(before.filter((_, i) => i !== 1));
    expect(before).not.toContain(board()[1]);
    expect(host.events.at(-1)).toEqual({ type: 'category.changed', cat: 1 });

    expect(host.hostView!.undo).toBe('category change');
    await host.host({ t: 'undo' });
    await until(() => board()[1] === before[1], 'the old category back');

    await host.host({ t: 'round.begin' });
    expect((await h.api('POST', `/games/${code}/reroll`, { cat: 1 }, key)).status).toBe(409);
  });

  it('records a finished game in the history and supports a rematch', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    await host.host({ t: 'start' });
    await host.host({ t: 'score.adjust', id: ann.playerId, delta: 400 });
    await host.host({ t: 'game.end' });
    await until(() => host.pub.phase === 'finished');
    expect(host.pub.champions).toEqual([ann.playerId]);

    const history = (await h.api<{ players: { name: string; score: number; champion: boolean }[] }[]>('GET', '/history')).body;
    expect(history).toHaveLength(1);
    expect(history[0].players[0]).toMatchObject({ name: 'Ann', score: 400, champion: true });

    const packs = (await h.api<PackSummary[]>('GET', '/packs')).body;
    const body = { packIds: [packs[0].id], rules: RULES };
    expect((await h.api('POST', `/games/${code}/rematch`, body)).status).toBe(403);
    expect((await h.api('POST', `/games/${code}/rematch`, body, { 'x-host-key': hostKey })).status).toBe(200);
    await until(() => host.pub.phase === 'lobby');
    expect(host.pub.players[0]).toMatchObject({ name: 'Ann', score: 0 });
    expect(ann.client.pub.phase).toBe('lobby');
  });

  it('plays again in the same room: nobody rejoins, both games are kept, and the questions are new', async () => {
    const store = new MemoryStore();
    h = await new Harness().start(store);
    const { code, hostKey } = await h.createGame();
    const key = { 'x-host-key': hostKey };
    const again = (headers: Record<string, string> = key) => h.api<ApiError>('POST', `/games/${code}/rematch`, undefined, headers);
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    const bo = await h.join(code, 'Bo');
    const board = (of = host) => (of.pub.round?.mode === 'trivia' ? of.pub.round.board.map((c) => c.title) : []);
    /** Start the show and play a clue from every category, so that all of them have been seen. */
    const play = async (winner: string) => {
      await host.host({ t: 'start' });
      await host.host({ t: 'round.begin' });
      // Handing someone the board settles the roll for the first pick, which is not what is being tested.
      await host.host({ t: 'control.set', id: winner });
      const titles = board();
      for (const cat of titles.keys()) {
        await host.host({ t: 'clue.select', cat, idx: 0 });
        await host.host({ t: 'clue.reveal' });
        await host.host({ t: 'clue.continue' });
      }
      await host.host({ t: 'score.adjust', id: winner, delta: 400 });
      return titles;
    };

    const first = await play(ann.playerId);
    // A game in play is never dealt over, and only the host can ask.
    expect((await again()).body.error.message).toMatch(/Finish this game/);
    expect(host.pub.phase).toBe('round');
    await host.host({ t: 'game.end' });
    await until(() => host.pub.phase === 'finished');
    expect((await again({})).status).toBe(403);

    // One request with nothing in it: the same format and packs, in the same room, for the same people.
    expect((await again()).status).toBe(200);
    await until(() => ann.client.pub.phase === 'lobby' && bo.client.pub.phase === 'lobby', 'both phones back in the lobby');
    expect(bo.client.events.at(-1)).toEqual({ type: 'game.rematch' });
    expect(host.pub.players.map((p) => [p.id, p.name, p.score, p.ready, p.connected])).toEqual([
      [ann.playerId, 'Ann', 0, false, true],
      [bo.playerId, 'Bo', 0, false, true],
    ]);
    expect(host.hostView!.undo).toBeNull();

    // Asked a second time (a double tap, a request sent again), the lobby everyone is in is left alone.
    await ann.client.act({ t: 'ready', ready: true });
    expect((await again()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(host.pub.players.map((p) => p.ready)).toEqual([true, false]);

    await bo.client.act({ t: 'ready', ready: true });
    const second = await play(bo.playerId);
    expect(second.filter((title) => first.includes(title))).toEqual([]);
    await host.host({ t: 'game.end' });
    await until(async () => (await h.api<GameResult[]>('GET', '/history')).body.length === 2, 'both games in History');
    const [later, earlier] = (await h.api<GameResult[]>('GET', '/history')).body;
    expect([earlier, later].map((game) => game.players.find((p) => p.champion)!.name)).toEqual(['Ann', 'Bo']);
    expect(later.id).not.toBe(earlier.id);
    expect(later.startedAt).toBeGreaterThanOrEqual(earlier.finishedAt);
    // Each seat is the same person in both games.
    const who = (game: GameResult) => Object.fromEntries(game.players.map((p) => [p.name, p.profileId]));
    expect(who(later)).toEqual(who(earlier));

    // What has been played is remembered across rooms and restarts: a brand-new game is dealt other questions too.
    await h.stop();
    h = await new Harness().start(store);
    const next = await h.createGame();
    const host2 = await h.connect('host', next.code, next.hostKey);
    await h.join(next.code, 'Cy');
    await host2.host({ t: 'start' });
    await until(() => board(host2).length > 0, 'the new game’s board');
    expect(board(host2).filter((title) => [...first, ...second].includes(title))).toEqual([]);
  });

  it('does not ask a Fast Money survey again until every survey has had its turn', async () => {
    h = await new Harness().start();
    const SURVEYS: GameRules = {
      ...RULES,
      rounds: [{
        mode: 'fastMoney', title: 'Surveys', questions: 3, participants: 'all', turnSec: 60, extraSecPerTurn: 0, blockDuplicates: false,
        reveal: 'atEnd', stakes: 'points', pointMultiplier: 10, target: 0, targetBonus: 0,
      }],
    };
    const asked: string[][] = [];
    /** Start the show and begin Fast Money, which is when its questions have been put to the room. */
    const play = async (host: Client) => {
      await host.host({ t: 'start' });
      await host.host({ t: 'round.begin' });
      await until(() => host.pub.round?.stage === 'ready' && host.hostView?.round?.mode === 'fastMoney', 'Fast Money to begin');
      const round = host.hostView!.round!;
      asked.push(round.mode === 'fastMoney' ? round.surveys.map((s) => s.question) : []);
      await host.host({ t: 'game.end' });
      await until(() => host.pub.phase === 'finished');
    };
    /** A new room, as when the host sets up a game from scratch, and then a second game in it with Play again. */
    const room = async (games: 1 | 2) => {
      const { code, hostKey } = await h.createGame(SURVEYS);
      const host = await h.connect('host', code, hostKey);
      const ann = await h.join(code, 'Ann');
      await play(host);
      if (games === 1) return;
      expect((await h.api('POST', `/games/${code}/rematch`, undefined, { 'x-host-key': hostKey })).status).toBe(200);
      await until(() => host.pub.phase === 'lobby');
      await ann.client.act({ t: 'ready', ready: true });
      await play(host);
    };

    // The starter pack has twelve surveys: four games of three, across two rooms, and none is asked twice.
    await room(2);
    await room(2);
    expect(asked.map((questions) => questions.length)).toEqual([3, 3, 3, 3]);
    expect(new Set(asked.flat()).size).toBe(12);
    // A fifth game has no choice but to repeat, and is given the three that have rested longest.
    await room(1);
    expect([...asked[4]].sort()).toEqual([...asked[0]].sort());
  });

  it('plays a Fast Money question out on every screen from one press, and takes it back as one', async () => {
    h = await new Harness().start();
    const HEAD_TO_HEAD: GameRules = {
      ...RULES,
      rounds: [{
        mode: 'fastMoney', title: 'Fast Money', questions: 2, participants: 'top2', turnSec: 45, extraSecPerTurn: 10, blockDuplicates: true,
        reveal: 'atEnd', stakes: 'decider', pointMultiplier: 10, target: 0, targetBonus: 0,
      }],
    };
    const { code, hostKey } = await h.createGame(HEAD_TO_HEAD);
    const host = await h.connect('host', code, hostKey);
    const tv = await h.connect('display', code);
    const ann = await h.join(code, 'Ann');
    const bo = await h.join(code, 'Bo');
    const screens = [host, tv, ann.client, bo.client];
    const fm = (of: Client = host) => (of.pub.round?.mode === 'fastMoney' ? of.pub.round : null);
    const secret = () => (host.hostView?.round?.mode === 'fastMoney' ? host.hostView.round : null);

    await host.host({ t: 'start' });
    await host.host({ t: 'round.begin' });
    await until(() => fm()?.stage === 'ready');
    for (const id of fm()!.turns.flat()) {
      await host.host({ t: 'fm.start' });
      await host.host({ t: 'fm.setAnswer', playerId: id, q: 0, text: `answer from ${id}` });
      await host.host({ t: 'fm.endTurn' });
    }
    await until(() => fm()?.stage === 'reveal' && secret()?.playing === false);
    for (const screen of screens) screen.events.length = 0;
    const heard: number[] = [];
    tv.socket.on('event', (e) => e.type === 'fm.reveal' && heard.push(Date.now()));

    // One press: both contestants' answers and points for question one, each a beat after the last.
    await host.host({ t: 'fm.reveal' });
    await until(() => secret()?.playing === true, 'the question to start playing');
    await until(() => secret()?.playing === false && secret()?.revealStep === 4, 'the question to play out', 8000);
    const beats = [{ type: 'fm.reveal', kind: 'answer' }, { type: 'fm.reveal', kind: 'points', points: 0 }];
    await until(() => screens.every((screen) => screen.events.length === 4), 'every screen to have heard it all');
    for (const screen of screens) expect(screen.events).toEqual([...beats, ...beats]);
    const gaps = heard.slice(1).map((at, i) => at - heard[i]);
    expect(gaps.map((ms, i) => Math.abs(ms - [1400, 1800, 1400][i]) < 250)).toEqual([true, true, true]);
    // Every screen shows the same board: question one out in full, question two untouched and waiting for the host.
    for (const screen of screens) expect(fm(screen)!.cells).toEqual(fm()!.cells);
    expect(Object.values(fm()!.cells).map((cells) => cells.map((cell) => cell.points))).toEqual([[0, null], [0, null]]);

    // Undo is one step back for the host too: the whole question, not a quarter of it.
    expect(host.hostView!.undo).toBe('reveal');
    await host.host({ t: 'undo' });
    await until(() => secret()?.revealStep === 0);
    expect(secret()!.playing).toBe(false);
    const blank = (screen: Client) => Object.values(fm(screen)!.cells).flat().every((cell) => cell.text === null && cell.points === null);
    await until(() => screens.every(blank), 'the question to be covered again on every screen');
  });

  it('keeps a seat with the player who earned it when they come back after a rematch on another browser', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    const bo = await h.join(code, 'Bo');
    const finish = async () => {
      await host.host({ t: 'start' });
      await host.host({ t: 'score.adjust', id: ann.playerId, delta: 400 });
      await host.host({ t: 'game.end' });
      await until(() => host.pub.phase === 'finished');
    };
    await finish();
    expect((await h.api('POST', `/games/${code}/rematch`, undefined, { 'x-host-key': hostKey })).status).toBe(200);
    await until(() => host.pub.phase === 'lobby');

    // Ann's phone drops out and she returns in a browser the server has never seen: same seat, no second Ann.
    ann.client.socket.disconnect();
    await until(() => !host.pub.players[0].connected, 'Ann to drop');
    const back = await h.join(code, 'Ann');
    expect(back.playerId).toBe(ann.playerId);
    expect(back.cookie).not.toBe(ann.cookie);
    expect(host.pub.players.map((p) => p.name)).toEqual(['Ann', 'Bo']);
    // The token her old browser held no longer opens the seat.
    await expect(h.connect('player', code, ann.token)).rejects.toThrow('unauthorized');

    await bo.client.act({ t: 'ready', ready: true });
    await until(() => host.pub.players.every((p) => p.connected && p.ready), 'Ann and Bo ready');
    await finish();
    await until(async () => (await h.api<GameResult[]>('GET', '/history')).body.length === 2, 'both games in History');
    const anns = (await h.api<GameResult[]>('GET', '/history')).body.map((game) => game.players.find((p) => p.name === 'Ann')!.profileId);
    expect(anns[0]).toBe(anns[1]);
    expect((await h.api<LeaderboardView>('GET', '/leaderboard')).body.players.filter((p) => p.name === 'Ann')).toMatchObject([{ games: 2, wins: 2 }]);
  });

  /** Play a two-player game to the end over the wire, the first player winning. Returns the phones' cookies. */
  async function playNight(names: [string, string], cookies: [string?, string?] = []) {
    const { code, hostKey } = await h.createGame();
    const host = await h.connect('host', code, hostKey);
    const first = await h.join(code, names[0], true, cookies[0]);
    const second = await h.join(code, names[1], true, cookies[1]);
    await host.host({ t: 'start' });
    await host.host({ t: 'score.adjust', id: first.playerId, delta: 400 });
    await host.host({ t: 'game.end' });
    await until(() => host.pub.phase === 'finished');
    return { host, first, second };
  }
  const board = async (headers: Record<string, string> = {}) => (await h.api<LeaderboardView>('GET', '/leaderboard', undefined, headers)).body;
  const named = (view: LeaderboardView, name: string) => view.players.filter((p) => p.name === name);

  it('keeps a leaderboard across games, recognising a phone whatever name it joins under', async () => {
    h = await new Harness().start();
    const one = await playNight(['Ann', 'Bo']);
    expect(one.first.cookie).toMatch(/^buzzoff_player=[\w-]{24,}$/);
    await until(async () => (await board()).games === 1, 'the first game to count');

    // Ann comes back under another name on the same phone; Bo comes back on a new one.
    await playNight(['Bo', 'Annie'], [undefined, one.first.cookie]);
    await until(async () => (await board()).games === 2, 'the second game to count');
    const view = await board({ cookie: one.first.cookie });
    const [annie] = named(view, 'Annie');
    expect(annie).toMatchObject({ aliases: ['Ann'], games: 2, wins: 1, points: 400 });
    expect(view.you).toBe(annie.id);
    expect((await board()).you).toBeNull();

    // Nothing ties the two Bos together but the name, and that is the host's call to make.
    const bos = named(view, 'Bo');
    expect(bos.map((p) => [p.games, p.wins]).sort()).toEqual([[1, 0], [1, 1]]);
    const clash = await h.api<ApiError>('POST', '/leaderboard/merge', { from: annie.id, into: bos[0].id });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/same game/);
    const merged = (await h.api<LeaderboardView>('POST', '/leaderboard/merge', { from: bos[0].id, into: bos[1].id })).body;
    expect(named(merged, 'Bo')).toMatchObject([{ id: bos[1].id, games: 2, wins: 1 }]);
    expect(named(merged, 'Bo')[0].identities.map((i) => i.id).sort()).toEqual(bos.map((p) => p.id).sort());
    const apart = (await h.api<LeaderboardView>('POST', '/leaderboard/separate', { id: bos[0].id })).body;
    expect(named(apart, 'Bo')).toHaveLength(2);

    // The standings are History added up: take a game out of one and it leaves the other.
    const history = (await h.api<GameResult[]>('GET', '/history')).body;
    expect(history[0].players.every((p) => /^[0-9a-f]{24}$/.test(p.profileId!))).toBe(true);
    await h.api('DELETE', `/history/${encodeURIComponent(history[0].id)}`);
    expect(await board()).toMatchObject({ games: 1, players: [{ games: 1 }, { games: 1 }] });
  });

  it('takes a game back out of the standings when its ending is undone, and never shows a screen who is who', async () => {
    h = await new Harness().start();
    const { host, first } = await playNight(['Ann', 'Bo']);
    await until(async () => (await board()).games === 1, 'the game to count');
    const { id } = (await board()).players[0].identities[0];
    expect(JSON.stringify([host.pub, host.hostView, first.client.you])).not.toContain(id);
    await host.host({ t: 'undo' });
    await until(async () => (await board()).games === 0, 'the game to stop counting');
  });

  it('shows the leaderboard to players only once the host opens it, and never lets them change it', async () => {
    h = await new Harness().start(new MemoryStore(), { BUZZOFF_ADMIN_PASSWORD: 'hunter2' });
    const auth = { authorization: `Bearer ${(await h.api<{ token: string }>('POST', '/auth/login', { password: 'hunter2' })).body.token}` };
    const { code, hostKey } = await h.createGame(RULES, auth);
    const host = await h.connect('host', code, hostKey);
    const ann = await h.join(code, 'Ann');
    await h.join(code, 'Bo');
    await host.host({ t: 'start' });
    await host.host({ t: 'score.adjust', id: ann.playerId, delta: 400 });
    await host.host({ t: 'game.end' });
    await until(async () => (await board(auth)).games === 1, 'the game to count');

    expect((await h.api<ServerInfo>('GET', '/info')).body.publicLeaderboard).toBe(false);
    expect((await h.api('GET', '/leaderboard')).status).toBe(403);
    expect(await board(auth)).toMatchObject({ canEdit: true, players: [{ identities: [{ games: 1 }] }, {}] });

    const { settings } = (await h.api<SettingsView>('GET', '/settings', undefined, auth)).body;
    expect((await h.api('PUT', '/settings', { ...settings, publicLeaderboard: true }, auth)).status).toBe(200);
    expect((await h.api<ServerInfo>('GET', '/info')).body.publicLeaderboard).toBe(true);
    const open = await board({ cookie: ann.cookie });
    expect(open).toMatchObject({ canEdit: false, games: 1, players: [{ name: 'Ann', wins: 1, identities: [] }, { name: 'Bo', identities: [] }] });
    expect(open.you).toBe(open.players[0].id);
    expect((await h.api('POST', '/leaderboard/merge', { from: open.players[0].id, into: open.players[1].id })).status).toBe(401);
    expect((await h.api('POST', '/leaderboard/separate', { id: open.players[0].id })).status).toBe(401);
  });
});
