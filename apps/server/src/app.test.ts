/**
 * Integration tests: a real server on a real port, driven over HTTP and
 * WebSockets exactly as browsers drive it.
 */
import type { AddressInfo } from 'node:net';
import {
  BUILTIN_PRESETS, DEFAULT_BUZZER,
  type Ack, type BuzzAck, type ClientToServerEvents, type CreateGameResponse, type GameEvent, type GameRules, type HostAction,
  type HostRoomView, type JoinResponse, type NetStat, type PackSummary, type PlayerAction, type PlayerView, type PublicView,
  type Role, type ServerToClientEvents,
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
  rounds: [{ mode: 'trivia', title: 'Board', categories: 2, cluesPerCategory: 2, valueMultiplier: 1, wagers: 0, wagerCap: 1000, selection: 'control', eliminateLowest: 0 }],
  buzzer: { ...DEFAULT_BUZZER, earlyBuzz: 'ignore', buzzSec: 0, answerSec: 0 },
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

/** Poll until a condition holds; state arrives asynchronously over the socket. */
async function until(condition: () => unknown, what = 'condition', timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
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
  async api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (res.status === 204 ? null : await res.json()) as T };
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
  async join(code: string, name: string) {
    const res = await this.api<JoinResponse>('POST', `/games/${code}/join`, { name, avatar: AVATAR });
    if (res.body.status !== 'joined') throw new Error(`could not join: ${JSON.stringify(res.body)}`);
    const { playerId, token } = res.body;
    return { playerId, token, client: await this.connect('player', code, token) };
  }
}

let h: Harness;
afterEach(async () => h?.stop());

describe('a game over the wire', () => {
  it('plays a clue end to end and keeps every screen in sync', async () => {
    h = await new Harness().start();
    const { code, hostKey } = await h.createGame();
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);

    const host = await h.connect('host', code, hostKey);
    const tv = await h.connect('display', code);
    const ann = await h.join(code, 'Ann');
    const bob = await h.join(code, 'Bob');
    await until(() => tv.pub.players.filter((p) => p.connected).length === 2, 'both players online');
    expect(host.hostView!.audience).toEqual({ displays: 1, spectators: 0 });

    expect(await host.host({ t: 'start' })).toEqual({ ok: true });
    await host.host({ t: 'round.begin' });
    await host.host({ t: 'clue.select', cat: 0, idx: 0 });
    await until(() => ann.client.you?.buzzer.state === 'wait', 'buzzer waiting');
    await host.host({ t: 'buzz.open' });
    await until(() => ann.client.you?.buzzer.state === 'open');

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
    // The answer is on the host's screen and nowhere else.
    const secret = host.hostView!.round!.mode === 'trivia' ? host.hostView!.round! : null;
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
    await host.host({ t: 'clue.select', cat: 0, idx: 0 });
    await host.host({ t: 'buzz.open' });

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
    expect(await host.host({ t: 'score.adjust', id: ann.playerId, delta: 1.5 } as HostAction)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await host.host({ t: 'made.up' } as unknown as HostAction)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(await host.host({ t: 'judge', correct: true })).toMatchObject({ ok: false, error: { code: 'bad_stage' } });
    expect(host.pub.players[0].score).toBe(0);

    expect((await h.api('GET', `/games/${code}/host`, undefined, { 'x-host-key': 'nope' })).status).toBe(403);
    expect((await h.api('GET', `/games/${code}/host`, undefined, { 'x-host-key': hostKey })).status).toBe(200);
    expect((await h.api('POST', `/games/${code}/join`, { name: '', avatar: AVATAR })).status).toBe(400);
    expect((await h.api('POST', `/games/${code}/join`, { name: 'Zed', avatar: { emoji: '<script>', color: 'red' } })).status).toBe(400);
    expect((await h.api('POST', `/games/${code}/join`, { name: 'ann', avatar: AVATAR })).status).toBe(409);
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
    await host.host({ t: 'buzz.open' });
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
});
