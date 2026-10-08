/**
 * One live connection to a room. Holds the latest views the server has sent
 * and exposes them to React through `useSyncExternalStore`.
 *
 * The client never computes game state. It renders what it is sent and asks
 * the server to do things; every action is acknowledged or rejected.
 */
import type {
  Ack, BuzzAck, ClientToServerEvents, GameEvent, HostAction, HostRoomView, NetStat, PlayerAction, PlayerView, PublicView, Role,
  ServerToClientEvents,
} from '@buzzoff/shared';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';

export type LinkStatus =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  /** The server refused us: wrong code or credentials. Retrying will not help. */
  | 'rejected'
  /** The server ended the session (kicked, replaced by another tab, room closed). */
  | 'ended';

export interface Snapshot {
  status: LinkStatus;
  reason: string | null;
  pub: PublicView | null;
  host: HostRoomView | null;
  you: PlayerView | null;
  net: Record<string, NetStat>;
  /** Add to Date.now() to get server time. */
  clockOffset: number;
}

const TIMEOUT_MS = 5000;
const timedOut: Ack<never> = { ok: false, error: { code: 'timeout', message: 'No reply from the server — check your connection' } };

export class Connection {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private snapshot: Snapshot = { status: 'connecting', reason: null, pub: null, host: null, you: null, net: {}, clockOffset: 0 };
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: GameEvent) => void>();
  private bestRtt = Infinity;
  private syncTimer: number | undefined;

  constructor(role: Role, code: string, token?: string) {
    this.socket = io({
      // WebSocket only, to match the server: polling would add jitter to buzzes.
      transports: ['websocket'],
      auth: { role, code, token },
      reconnectionDelay: 400,
      reconnectionDelayMax: 3000,
      timeout: 8000,
    });
    const s = this.socket;
    s.on('connect', () => {
      this.set({ status: 'online', reason: null });
      this.bestRtt = Infinity;
      this.syncClock();
    });
    s.on('disconnect', (reason) => {
      if (this.snapshot.status === 'ended') return;
      // "io server disconnect" means the server closed us deliberately; socket.io will not retry by itself.
      if (reason === 'io server disconnect') s.connect();
      this.set({ status: 'reconnecting' });
    });
    s.on('connect_error', (err) => {
      const fatal = ['no_room', 'unauthorized', 'bad_handshake'].includes(err.message);
      this.set(fatal ? { status: 'rejected', reason: err.message } : { status: this.snapshot.pub ? 'reconnecting' : 'connecting' });
      if (fatal) s.disconnect();
    });
    s.on('state', (pub) => {
      // Views carry a sequence number; never let a stale one overwrite a newer one.
      if (this.snapshot.pub && pub.seq < this.snapshot.pub.seq && pub.code === this.snapshot.pub.code) return;
      this.set({ pub });
    });
    s.on('host', (host) => this.set({ host }));
    s.on('you', (you) => this.set({ you }));
    s.on('net', (net) => this.set({ net: { ...this.snapshot.net, ...net } }));
    s.on('probe', (ack) => ack());
    s.on('event', (event) => this.eventListeners.forEach((fn) => fn(event)));
    s.on('bye', (reason) => {
      this.set({ status: 'ended', reason });
      s.disconnect();
    });
    this.syncTimer = window.setInterval(() => this.syncClock(), 20_000);
  }

  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  /** Estimate the server clock so deadlines render correctly whatever this device's clock says. */
  private syncClock(remaining = 4) {
    if (!this.socket.connected) return;
    const sent = performance.now();
    const sentWall = Date.now();
    this.socket.timeout(3000).emit('time', (err, serverNow) => {
      if (err) return;
      const rtt = performance.now() - sent;
      // The sample with the shortest round trip has the least room for error.
      if (rtt < this.bestRtt) {
        this.bestRtt = rtt;
        this.set({ clockOffset: serverNow + rtt / 2 - (sentWall + rtt) });
      }
      if (remaining > 1) window.setTimeout(() => this.syncClock(remaining - 1), 300);
    });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  onEvent(fn: (e: GameEvent) => void) {
    this.eventListeners.add(fn);
    return () => void this.eventListeners.delete(fn);
  }

  /** Send an action; if the reply is lost, retry once with the same id so it cannot apply twice. */
  private async send<A>(event: 'host:action' | 'player:action', action: A): Promise<Ack> {
    const msg = { id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, action };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.socket.timeout(TIMEOUT_MS).emitWithAck(event, msg as never);
      } catch {
        /* timed out: try again */
      }
    }
    return timedOut;
  }

  host = (action: HostAction) => this.send('host:action', action);
  act = (action: PlayerAction) => this.send('player:action', action);

  async buzz(): Promise<Ack<BuzzAck>> {
    try {
      return await this.socket.timeout(TIMEOUT_MS).emitWithAck('buzz');
    } catch {
      return timedOut;
    }
  }

  close() {
    window.clearInterval(this.syncTimer);
    this.socket.disconnect();
  }
}

/** Open a connection for the lifetime of a component. */
export function useConnection(role: Role, code: string, token?: string | null) {
  const conn = useMemo(() => new Connection(role, code, token ?? undefined), [role, code, token]);
  useEffect(() => () => conn.close(), [conn]);
  const snap = useSyncExternalStore(conn.subscribe, conn.getSnapshot);
  return { conn, snap };
}
