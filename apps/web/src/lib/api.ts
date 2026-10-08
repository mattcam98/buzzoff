/** Typed wrapper around the HTTP API. */
import type {
  ClaimStatus, CreateGameRequest, CreateGameResponse, GameInfo, GameResult, GameRules, JoinRequest, JoinResponse, Media, Pack,
  PackContent, PackFile, PackSummary, Preset, ServerInfo,
} from '@buzzoff/shared';
import { storage } from './storage';

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const token = storage.adminToken();
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure(0, 'offline', 'Could not reach the server');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiFailure(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const hostKey = (code: string) => ({ 'x-host-key': storage.hostKey(code) ?? '' });

export const api = {
  info: () => request<ServerInfo>('GET', '/info'),
  login: (password: string) => request<{ token: string }>('POST', '/auth/login', { password }),
  checkAuth: () => request<{ ok: true }>('GET', '/auth/check'),

  packs: () => request<PackSummary[]>('GET', '/packs'),
  pack: (id: string) => request<Pack>('GET', `/packs/${id}`),
  createPack: (content: PackContent) => request<Pack>('POST', '/packs', content),
  savePack: (id: string, content: PackContent) => request<Pack>('PUT', `/packs/${id}`, content),
  deletePack: (id: string) => request<void>('DELETE', `/packs/${id}`),
  exportPack: (id: string) => request<PackFile>('GET', `/packs/${id}/export`),
  importPack: (file: unknown) => request<Pack>('POST', '/packs/import', file),

  presets: () => request<Preset[]>('GET', '/presets'),
  savePreset: (preset: { name: string; description: string; rules: GameRules }) => request<Preset>('POST', '/presets', preset),
  deletePreset: (id: string) => request<void>('DELETE', `/presets/${id}`),

  uploadMedia(file: File) {
    const form = new FormData();
    form.append('file', file);
    return request<Media>('POST', '/media', form);
  },

  createGame: (req: CreateGameRequest) => request<CreateGameResponse>('POST', '/games', req),
  game: (code: string) => request<GameInfo>('GET', `/games/${code}`),
  join: (code: string, req: JoinRequest) => request<JoinResponse>('POST', `/games/${code}/join`, req),
  claim: (code: string, id: string, secret: string) =>
    request<ClaimStatus>('GET', `/games/${code}/claims/${id}?secret=${encodeURIComponent(secret)}`),
  checkHost: (code: string) => request<{ ok: true }>('GET', `/games/${code}/host`, undefined, hostKey(code)),
  rematch: (code: string, req: CreateGameRequest) => request<{ ok: true }>('POST', `/games/${code}/rematch`, req, hostKey(code)),
  deleteGame: (code: string) => request<void>('DELETE', `/games/${code}`, undefined, hostKey(code)),

  history: () => request<GameResult[]>('GET', '/history'),
  deleteResult: (id: string) => request<void>('DELETE', `/history/${encodeURIComponent(id)}`),
};
