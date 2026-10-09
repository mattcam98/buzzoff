/**
 * A live game room: the authoritative state plus everything around it that is
 * not game logic — sockets, credentials, undo history, timers, persistence.
 *
 * Node runs this on one thread, and every change goes through `commit`, so
 * transitions are applied strictly one at a time in arrival order. That is the
 * whole concurrency model: there is nothing to lock.
 */
import {
  applyBuzz, applyHost, applyPlayer, applySystem, buildResult, findPlayerByName, GameError, HostActionSchema, hostView,
  nextDeadline, PlayerActionSchema, playerView, publicView, restoreSnapshot,
  type Ack, type Avatar, type Claim, type ClaimStatus, type ClientToServerEvents, type Env, type GameRules, type GameState,
  type HostAction, type HostRoomView, type JoinResponse, type NetStat, type Outcome, type PlayerAction, type Role,
  type RoundState, type ServerToClientEvents,
} from '@buzzoff/shared';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type { Results } from './results';
import type { SavedGame, Store } from './store/types';
import { Bucket, clock, log, random, randomId, randomToken, RecentIds, sha256, tokenMatches } from './util';

interface SocketData {
  role: Role;
  code: string;
  playerId?: string;
}
export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Host actions worth a line in the undo history, with the label shown on the undo button. */
const UNDOABLE: Partial<Record<HostAction['t'], string>> = {
  start: 'start game', judge: 'ruling', 'score.adjust': 'score change', 'score.set': 'score change',
  'clue.select': 'clue pick', 'clue.reveal': 'answer reveal', 'clue.continue': 'back to board', 'clue.cancel': 'cancelled clue',
  'buzz.reset': 'buzzer reset', 'wager.set': 'wager', 'control.set': 'control change',
  'round.begin': 'round start', 'round.end': 'round end', 'round.next': 'next round', 'game.end': 'end game',
  'player.eliminate': 'elimination', 'fm.start': 'turn start', 'fm.endTurn': 'turn end', 'fm.reveal': 'reveal',
  'fm.override': 'answer match', 'fm.setAnswer': 'answer entry', 'fm.next': 'next step',
  'final.advance': 'final step', 'final.show': 'answer reveal', 'final.judge': 'ruling',
};
const HISTORY_LIMIT = 40;
const RTT_SAMPLES = 7;
const PROBE_INTERVAL_MS = 2500;
const CLAIM_TTL_MS = 10 * 60_000;
const MAX_PENDING_CLAIMS = 8;
const JOIN_GRACE_MS = 5000;

const envelope = <T extends z.ZodType>(action: T) => z.object({ id: z.string().min(1).max(64), action });
const HostEnvelope = envelope(HostActionSchema);
const PlayerEnvelope = envelope(PlayerActionSchema);

const OK: Ack = { ok: true, data: undefined };
const failure = (code: string, message: string): Ack<never> => ({ ok: false, error: { code, message } });

function toFailure(err: unknown, code: string): Ack<never> {
  if (err instanceof GameError) return failure(err.code, err.message);
  log.error('unexpected error handling action', { code, err });
  return failure('internal', 'Something went wrong on the server');
}

interface ClaimRecord extends Claim {
  /** Who is asking, if their phone said. */
  profileId?: string;
  secretHash: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'denied';
  token?: string;
}

export class Room {
  state: GameState;
  readonly secrets: SavedGame['secrets'];
  /** Which returning player is in which seat. It goes into the result, never into a view. */
  private profiles: Record<string, string>;
  updatedAt: number;

  private history: { state: GameState; at: number; label: string }[] = [];
  private claims = new Map<string, ClaimRecord>();
  private rtt = new Map<string, number[]>();
  private playerSockets = new Map<string, AppSocket>();
  private audience = { display: new Set<string>(), spectator: new Set<string>() };
  private lastYou = new Map<string, string>();
  /** Players who have joined but whose phone has never connected. */
  private unconnected = new Set<string>();
  private seen = new RecentIds();
  private tickTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  private netTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private io: AppServer,
    private store: Store,
    private results: Results,
    saved: SavedGame,
  ) {
    this.state = saved.state;
    this.secrets = saved.secrets;
    this.profiles = this.secrets.profiles ??= {};
    this.updatedAt = saved.updatedAt;
    this.netTimer = setInterval(() => this.io.to(this.hostChannel).emit('net', this.netStats()), PROBE_INTERVAL_MS).unref();
    this.schedule();
  }

  get code() {
    return this.state.code;
  }
  private get channel() {
    return `room:${this.code}`;
  }
  private get hostChannel() {
    return `room:${this.code}:host`;
  }
  private playerChannel(id: string) {
    return `room:${this.code}:player:${id}`;
  }
  private get resultId() {
    return `${this.code}-${Math.round(this.state.createdAt)}-${this.secrets.plays}`;
  }

  private env(now = clock()): Env {
    return { now, rand: random, rtt: (id) => this.netStat(id)?.rttMs ?? null };
  }

  // -------------------------------------------------------------- credentials

  isHost(key: string | undefined) {
    return tokenMatches(key, this.secrets.hostKeyHash);
  }

  /** The player a token belongs to, or null. */
  playerFor(token: string | undefined): string | null {
    if (!token) return null;
    for (const [id, hash] of Object.entries(this.secrets.players)) {
      if (this.state.players[id] && tokenMatches(token, hash)) return id;
    }
    return null;
  }

  // -------------------------------------------------------------- state changes

  /** The single place state changes: swap it in, tell everyone, re-arm timers, persist. */
  private commit(out: Outcome) {
    const wasFinished = this.state.phase === 'finished';
    this.state = out.state;
    this.updatedAt = Date.now();
    for (const event of out.events) this.io.to(this.channel).emit('event', event);
    this.broadcast();
    this.schedule();
    this.save();
    if (!wasFinished && this.state.phase === 'finished') {
      this.results.save(buildResult(this.state, this.resultId, this.profiles)).catch((err) => log.error('could not save result', { code: this.code, err }));
      log.info('game finished', { code: this.code, players: this.state.order.length });
    }
  }

  private broadcast() {
    this.io.to(this.channel).emit('state', publicView(this.state));
    this.broadcastHost();
    for (const id of this.playerSockets.keys()) this.sendYou(id);
  }

  private broadcastHost() {
    this.io.to(this.hostChannel).emit('host', this.hostRoomView());
  }

  /** Private views are only resent when they actually change. */
  private sendYou(playerId: string) {
    const view = playerView(this.state, playerId);
    const json = JSON.stringify(view);
    if (this.lastYou.get(playerId) === json) return;
    this.lastYou.set(playerId, json);
    this.io.to(this.playerChannel(playerId)).emit('you', view);
  }

  private hostRoomView(): HostRoomView {
    this.pruneClaims();
    return {
      ...hostView(this.state),
      undo: this.history.at(-1)?.label ?? null,
      claims: [...this.claims.values()].filter((c) => c.status === 'pending').map(({ id, playerId, name }) => ({ id, playerId, name })),
      audience: { displays: this.audience.display.size, spectators: this.audience.spectator.size },
    };
  }

  /** One timer per room, always pointed at the next deadline the engine reports. */
  private schedule() {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    const due = this.closed ? null : nextDeadline(this.state);
    if (due === null) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      // Timers can fire a moment early; a tick before the deadline would change nothing but still be broadcast.
      if (clock() < due) return this.schedule();
      try {
        this.commit(applySystem(this.state, { t: 'tick' }, this.env()));
      } catch (err) {
        log.error('tick failed', { code: this.code, err });
      }
    }, Math.max(0, Math.ceil(due - clock())));
  }

  host(action: HostAction) {
    if (action.t === 'undo') return this.undo();
    if (action.t === 'claim.resolve') return this.resolveClaim(action.claimId, action.approve);

    const before = this.state;
    const at = clock();
    const out = applyHost(before, action, this.env(at));
    const label = UNDOABLE[action.t];
    if (label) {
      this.history.push({ state: before, at, label });
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
    }
    if (action.t === 'player.kick') this.forget(action.id);
    this.commit(out);
  }

  private undo() {
    const snapshot = this.history.pop();
    if (!snapshot) throw new GameError('nothing_to_undo', 'Nothing to undo');
    const wasFinished = this.state.phase === 'finished';
    const resultId = this.resultId;
    this.commit({ state: restoreSnapshot(this.state, snapshot.state, snapshot.at, clock()), events: [] });
    if (wasFinished && this.state.phase !== 'finished') {
      this.results.remove(resultId).catch((err) => log.error('could not delete result', { code: this.code, err }));
    }
  }

  player(playerId: string, action: PlayerAction) {
    try {
      this.commit(applyPlayer(this.state, playerId, action, this.env()));
    } catch (err) {
      // The room hears the "already said" buzzer even though the answer was rejected.
      if (action.t === 'fm.answer' && err instanceof GameError && err.code === 'duplicate') this.io.to(this.channel).emit('event', { type: 'fm.duplicate', playerId });
      throw err;
    }
  }

  /** `now` is taken by the caller the instant the buzz arrives, before any other work. */
  buzz(playerId: string, now: number) {
    const out = applyBuzz(this.state, playerId, this.env(now));
    if (out.state !== this.state) this.commit(out);
    return out.ack;
  }

  rematch(rules: GameRules, rounds: RoundState[], packTitles: string[]) {
    this.secrets.plays += 1;
    this.history = [];
    this.commit(applySystem(this.state, { t: 'rematch', rules, rounds, packTitles }, this.env()));
  }

  // -------------------------------------------------------------- joining

  /** `profileId` is who the joining phone says it is (see `identify` in http.ts), if it says. */
  join(name: string, avatar: Avatar, profileId?: string): JoinResponse {
    const existing = findPlayerByName(this.state, name);
    // A seat whose phone has not connected yet is not abandoned, it is still arriving: two people
    // picking the same name at the same moment must not end up sharing one.
    const arriving = existing && this.unconnected.has(existing.id) && clock() - existing.joinedAt < JOIN_GRACE_MS;
    if (existing && !arriving && !existing.connected && this.state.phase !== 'finished') {
      // Someone is asking for a disconnected player's seat. In the lobby
      // nothing is at stake, so hand it over; mid-game the host decides.
      if (this.state.phase === 'lobby') {
        // Nothing has been played in this seat, so it is simply whoever holds it now.
        this.seat(existing.id, profileId);
        return { status: 'joined', playerId: existing.id, token: this.issueToken(existing.id) };
      }
      return this.openClaim(existing.id, existing.name, profileId);
    }
    const id = randomId();
    const out = applySystem(this.state, { t: 'join', id, name, avatar }, this.env());
    this.seat(id, profileId);
    const token = this.issueToken(id);
    this.unconnected.add(id);
    this.commit(out);
    return { status: 'joined', playerId: id, token };
  }

  private seat(playerId: string, profileId: string | undefined) {
    if (profileId) this.profiles[playerId] = profileId;
    else delete this.profiles[playerId];
  }

  /** Issue a fresh token, invalidating any earlier one for this player. */
  private issueToken(playerId: string) {
    const token = randomToken();
    this.secrets.players[playerId] = sha256(token);
    this.save();
    return token;
  }

  private pruneClaims() {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (const [id, claim] of this.claims) if (claim.createdAt < cutoff) this.claims.delete(id);
  }

  private openClaim(playerId: string, name: string, profileId?: string): JoinResponse {
    this.pruneClaims();
    const pending = [...this.claims.values()].filter((c) => c.status === 'pending');
    if (pending.length >= MAX_PENDING_CLAIMS) throw new GameError('busy', 'Too many people are waiting to rejoin — ask the host');
    const claimSecret = randomToken();
    const claim: ClaimRecord = { id: randomId(), playerId, name, profileId, secretHash: sha256(claimSecret), createdAt: Date.now(), status: 'pending' };
    this.claims.set(claim.id, claim);
    this.broadcastHost();
    return { status: 'pending', claimId: claim.id, claimSecret };
  }

  private resolveClaim(claimId: string, approve: boolean) {
    const claim = this.claims.get(claimId);
    if (!claim || claim.status !== 'pending') throw new GameError('no_claim', 'That request has expired');
    if (approve && this.state.players[claim.playerId]) {
      // Mid-game the seat stays with whoever started in it: a takeover is the same person on another
      // phone far more often than a substitute. A seat nobody was known in takes the newcomer.
      if (!this.profiles[claim.playerId]) this.seat(claim.playerId, claim.profileId);
      claim.token = this.issueToken(claim.playerId);
      claim.status = 'approved';
      this.playerSockets.get(claim.playerId)?.emit('bye', 'replaced');
      this.playerSockets.get(claim.playerId)?.disconnect(true);
    } else {
      claim.status = 'denied';
    }
    this.broadcastHost();
  }

  claimStatus(claimId: string, secret: string): ClaimStatus | null {
    const claim = this.claims.get(claimId);
    if (!claim || !tokenMatches(secret, claim.secretHash)) return null;
    if (claim.status === 'pending') return { status: 'pending' };
    this.claims.delete(claimId); // The answer is collected once.
    return claim.status === 'approved' && claim.token ? { status: 'approved', playerId: claim.playerId, token: claim.token } : { status: 'denied' };
  }

  private forget(playerId: string) {
    delete this.secrets.players[playerId];
    delete this.profiles[playerId];
    this.rtt.delete(playerId);
    this.lastYou.delete(playerId);
    this.unconnected.delete(playerId);
    const socket = this.playerSockets.get(playerId);
    this.playerSockets.delete(playerId);
    socket?.emit('bye', 'kicked');
    socket?.disconnect(true);
  }

  // -------------------------------------------------------------- connection quality

  private netStat(playerId: string): NetStat | null {
    const samples = this.rtt.get(playerId);
    if (!samples?.length) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    return { rttMs: Math.round(sorted[Math.floor(sorted.length / 2)]), jitterMs: Math.round(sorted[sorted.length - 1] - sorted[0]) };
  }

  private netStats(): Record<string, NetStat> {
    const all: Record<string, NetStat> = {};
    for (const id of this.playerSockets.keys()) {
      const stat = this.netStat(id);
      if (stat) all[id] = stat;
    }
    return all;
  }

  /**
   * Round-trip time is measured by the server: it sends a probe and times the
   * acknowledgement on its own clock. A client can make its connection look
   * slower by delaying the reply, but never faster.
   */
  private probe(socket: AppSocket, playerId: string) {
    const once = () => {
      const sent = performance.now();
      socket.timeout(4000).emit('probe', (err: Error | null) => {
        if (err || this.playerSockets.get(playerId) !== socket) return;
        const samples = this.rtt.get(playerId) ?? [];
        samples.push(performance.now() - sent);
        if (samples.length > RTT_SAMPLES) samples.shift();
        this.rtt.set(playerId, samples);
        const stat = this.netStat(playerId);
        if (stat) socket.emit('net', { [playerId]: stat });
      });
    };
    // A quick burst so there is a usable estimate before the first clue.
    const timers = [0, 250, 600, 1000].map((delay) => setTimeout(once, delay));
    const interval = setInterval(once, PROBE_INTERVAL_MS);
    socket.on('disconnect', () => {
      timers.forEach(clearTimeout);
      clearInterval(interval);
    });
  }

  // -------------------------------------------------------------- sockets

  attach(socket: AppSocket) {
    const { role, playerId } = socket.data;
    const bucket = new Bucket(20, 40);
    const limited = failure('rate_limited', 'Slow down a little');
    socket.join(this.channel);
    socket.emit('state', publicView(this.state));
    socket.on('time', (ack) => typeof ack === 'function' && ack(clock()));

    if (role === 'host') {
      socket.join(this.hostChannel);
      socket.emit('host', this.hostRoomView());
      socket.emit('net', this.netStats());
      socket.on('host:action', (msg, ack) => {
        if (typeof ack !== 'function') return;
        if (!bucket.take()) return ack(limited);
        const parsed = HostEnvelope.safeParse(msg);
        if (!parsed.success) return ack(failure('invalid', 'That request was not understood'));
        if (this.seen.has(parsed.data.id)) return ack(OK);
        try {
          this.host(parsed.data.action);
          this.seen.add(parsed.data.id);
          ack(OK);
        } catch (err) {
          ack(toFailure(err, this.code));
        }
      });
      return;
    }

    if (role === 'player' && playerId) {
      const previous = this.playerSockets.get(playerId);
      this.playerSockets.set(playerId, socket);
      this.unconnected.delete(playerId);
      if (previous) {
        previous.emit('bye', 'replaced');
        previous.disconnect(true);
      }
      socket.join(this.playerChannel(playerId));
      this.lastYou.delete(playerId);
      this.setPresence(playerId, true);
      this.probe(socket, playerId);

      socket.on('buzz', (ack) => {
        const now = clock();
        if (typeof ack !== 'function') return;
        if (!bucket.take()) return ack(limited);
        try {
          ack({ ok: true, data: this.buzz(playerId, now) });
        } catch (err) {
          ack(toFailure(err, this.code));
        }
      });
      socket.on('player:action', (msg, ack) => {
        if (typeof ack !== 'function') return;
        if (!bucket.take()) return ack(limited);
        const parsed = PlayerEnvelope.safeParse(msg);
        if (!parsed.success) return ack(failure('invalid', parsed.error.issues[0]?.message ?? 'That request was not understood'));
        if (this.seen.has(parsed.data.id)) return ack(OK);
        try {
          this.player(playerId, parsed.data.action);
          this.seen.add(parsed.data.id);
          ack(OK);
        } catch (err) {
          ack(toFailure(err, this.code));
        }
      });
      socket.on('disconnect', () => {
        if (this.playerSockets.get(playerId) !== socket) return;
        this.playerSockets.delete(playerId);
        this.setPresence(playerId, false);
      });
      return;
    }

    const watchers = role === 'display' ? this.audience.display : this.audience.spectator;
    watchers.add(socket.id);
    this.broadcastHost();
    socket.on('disconnect', () => {
      watchers.delete(socket.id);
      this.broadcastHost();
    });
  }

  private setPresence(playerId: string, connected: boolean) {
    if (this.closed || !this.state.players[playerId]) return;
    if (this.state.players[playerId].connected !== connected) {
      this.commit(applySystem(this.state, { t: 'presence', id: playerId, connected }, this.env()));
    } else if (connected) {
      this.sendYou(playerId);
    }
  }

  // -------------------------------------------------------------- persistence

  /** Coalesce bursts of changes into one write. */
  private save() {
    if (this.saveTimer || this.closed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 250);
  }

  /** Writes are chained so an older snapshot can never land after a newer one. */
  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saving = this.saving.then(async () => {
      if (this.closed) return;
      try {
        await this.store.saveGame({ code: this.code, state: this.state, secrets: this.secrets, updatedAt: this.updatedAt });
      } catch (err) {
        log.error('could not save game', { code: this.code, err });
      }
    });
    return this.saving;
  }

  /** Stop timers and disconnect everyone. The caller decides whether to delete the saved game. */
  async close(reason: 'closed' | null) {
    await this.flush();
    this.closed = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    clearInterval(this.netTimer);
    if (reason) {
      this.io.to(this.channel).emit('bye', reason);
      this.io.in(this.channel).disconnectSockets(true);
    }
  }
}
