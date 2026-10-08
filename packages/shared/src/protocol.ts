/**
 * The wire contract between browsers and the server: Socket.IO events and the
 * JSON bodies of the HTTP API.
 */
import { z } from 'zod';
import { AvatarSchema, NameSchema, type BuzzAck, type HostAction, type PlayerAction } from './actions';
import { GameRulesSchema } from './rules';
import type { GameEvent, GamePhase } from './state';
import type { HostView, PlayerView, PublicView } from './views';

export const ROOM_CODE_LENGTH = 4;
/** No vowels (so codes never spell words) and nothing easily misheard or misread. */
export const ROOM_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const normalizeRoomCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, ROOM_CODE_LENGTH);

export type Role = 'host' | 'player' | 'display' | 'spectator';

export const HandshakeSchema = z.object({
  role: z.enum(['host', 'player', 'display', 'spectator']),
  code: z.string().min(1).max(8),
  /** Host key or player token; displays and spectators need none. */
  token: z.string().max(200).optional(),
});
export type Handshake = z.infer<typeof HandshakeSchema>;

export type Ack<T = undefined> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** Connection quality as measured by the server. */
export interface NetStat {
  /** Median of recent round trips, in ms. */
  rttMs: number;
  /** Spread between the fastest and slowest recent round trip. */
  jitterMs: number;
}

export interface Claim {
  id: string;
  /** The disconnected player someone is asking to take over. */
  playerId: string;
  name: string;
}

/** Everything the host dashboard needs beyond the public view. */
export interface HostRoomView extends HostView {
  /** Description of the action `undo` would revert, or null. */
  undo: string | null;
  claims: Claim[];
  audience: { displays: number; spectators: number };
}

/**
 * Actions travel in an envelope with a client-generated id. The server
 * remembers recent ids, so a retried or duplicated message is applied once.
 */
export interface Envelope<A> {
  id: string;
  action: A;
}

export interface ClientToServerEvents {
  'host:action': (msg: Envelope<HostAction>, ack: (r: Ack) => void) => void;
  'player:action': (msg: Envelope<PlayerAction>, ack: (r: Ack) => void) => void;
  buzz: (ack: (r: Ack<BuzzAck>) => void) => void;
  /** Clock sync: the server replies with its current time. */
  time: (ack: (serverNow: number) => void) => void;
}

export interface ServerToClientEvents {
  state: (view: PublicView) => void;
  host: (view: HostRoomView) => void;
  you: (view: PlayerView) => void;
  event: (event: GameEvent) => void;
  /** Sent to a player about themselves, and to the host about everyone. */
  net: (stats: Record<string, NetStat>) => void;
  /** The server times how long this takes to come back. */
  probe: (ack: () => void) => void;
  bye: (reason: 'kicked' | 'replaced' | 'closed') => void;
}

// ---------------------------------------------------------------- HTTP

export const CreateGameSchema = z.object({
  packIds: z.array(z.string().max(40)).min(1).max(10),
  rules: GameRulesSchema,
  picks: z.array(z.array(z.string().max(40)).max(12).nullable()).max(8).optional(),
});
export type CreateGameRequest = z.infer<typeof CreateGameSchema>;
export interface CreateGameResponse {
  code: string;
  hostKey: string;
}

export const JoinSchema = z.object({ name: NameSchema, avatar: AvatarSchema });
export type JoinRequest = z.infer<typeof JoinSchema>;
export type JoinResponse =
  | { status: 'joined'; playerId: string; token: string }
  /** The name belongs to a disconnected player; the host must approve the takeover. */
  | { status: 'pending'; claimId: string; claimSecret: string };
export type ClaimStatus = { status: 'pending' } | { status: 'denied' } | { status: 'approved'; playerId: string; token: string };

export interface GameInfo {
  code: string;
  name: string;
  phase: GamePhase;
  playerCount: number;
  joinable: boolean;
}

export interface ServerInfo {
  version: string;
  /** Whether hosting requires the admin password. */
  authRequired: boolean;
  /** Where players should be sent, if the server was told its public address. */
  publicUrl: string | null;
}

export interface ApiError {
  error: { code: string; message: string };
}
