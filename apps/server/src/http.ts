/** The HTTP API, uploaded media, and the built web app. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AppSettingsSchema, BUILTIN_PRESETS, ChangePasswordSchema, CreateGameSchema, GameError, GameRulesSchema, JoinSchema,
  PackContentSchema, PackFileSchema, summarizePack,
  type ApiError, type GameInfo, type LeaderboardView, type Pack, type PackContent, type PackFile, type Preset, type ServerInfo,
  type SettingsView,
} from '@buzzoff/shared';
import compression from 'compression';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { AdminAuth, Caller } from './auth';
import { VERSION, type Config } from './config';
import { storeMedia } from './media';
import type { Results } from './results';
import type { Room } from './room';
import type { Rooms } from './rooms';
import type { Audit, Settings } from './settings';
import type { Store } from './store/types';
import { cookie, Limiter, log, randomId, randomToken, sha256 } from './util';

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The 4xx status carried by an error Express raised about the request, if that is what this is. */
function clientError(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : null;
}

const bearer = (req: Request) => req.get('authorization')?.replace(/^Bearer\s+/i, '');
const caller = (req: Request): Caller => ({ ip: req.ip ?? 'unknown', agent: req.get('user-agent') ?? '' });

/**
 * How a returning player is recognised without an account. A phone is given a random key in a
 * cookie the first time it joins a game; it is HttpOnly, so no script can read or lose it, and it
 * outlasts the storage that browsers clear on their own. The key itself is never stored or sent
 * anywhere else: results carry a hash of it, which says "the same phone as last time" and nothing more.
 */
const PLAYER_COOKIE = 'buzzoff_player';
const PLAYER_COOKIE_DAYS = 400; // the longest a browser will keep one; every join starts it again
const profileId = (key: string) => sha256(key).slice(0, 24);
function playerKey(req: Request): string | null {
  const key = cookie(req.get('cookie'), PLAYER_COOKIE);
  return key && /^[\w-]{24,64}$/.test(key) ? key : null;
}
/** Who is joining: the phone's existing key, or a new one, kept for next time either way. */
function identify(req: Request, res: Response): string {
  const key = playerKey(req) ?? randomToken();
  res.cookie(PLAYER_COOKIE, key, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/api', maxAge: PLAYER_COOKIE_DAYS * 86_400_000 });
  return profileId(key);
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw new HttpError(400, 'invalid', `${where}${issue.message}`);
}

export function createHttp(deps: { config: Config; store: Store; rooms: Rooms; results: Results; auth: AdminAuth; settings: Settings; audit: Audit }) {
  const { config, store, rooms, results, auth, settings, audit } = deps;
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      // Question media may be hot-linked from anywhere; scripts only ever come from this server.
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; " +
        "style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'self'",
    });
    next();
  });
  app.use(compression());
  app.use(express.json({ limit: '4mb' }));

  // Generous for people playing, tight for anything that guesses secrets. A whole
  // party usually shares one public address, so joining allows a full room at once.
  const general = new Limiter(20, 60);
  const joining = new Limiter(2, 40);
  const logins = new Limiter(0.1, 6);
  const limit =
    (limiter: Limiter): RequestHandler =>
    (req, _res, next) =>
      next(limiter.allow(req.ip ?? 'unknown') ? undefined : new HttpError(429, 'rate_limited', 'Too many requests — wait a moment and try again'));

  const admin: RequestHandler = (req, _res, next) =>
    next(auth.allows(bearer(req)) ? undefined : new HttpError(401, 'unauthorized', 'Host password required'));

  const roomOf = (req: Request): Room => rooms.get(String(req.params.code)) ?? notFound('No game with that code');
  const notFound = (message: string): never => {
    throw new HttpError(404, 'not_found', message);
  };
  const hostOnly = (req: Request): Room => {
    const room = roomOf(req);
    if (!room.isHost(req.get('x-host-key'))) throw new HttpError(403, 'forbidden', 'That is not your game');
    return room;
  };

  const api = express.Router();
  api.use(limit(general));

  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  api.get('/info', (_req, res) => {
    const { publicUrl, defaultPresetId, publicLeaderboard } = settings.current;
    res.json({ version: VERSION, authRequired: auth.required, publicUrl, defaultPresetId, publicLeaderboard } satisfies ServerInfo);
  });

  // ------------------------------------------------------------ sign-in

  api.post('/auth/login', limit(logins), async (req, res) => {
    const { password } = parse(z.object({ password: z.string().max(200) }), req.body);
    const token = await auth.login(password, caller(req));
    if (!token) throw new HttpError(401, 'unauthorized', 'Wrong password');
    res.json({ token });
  });
  api.get('/auth/check', admin, (_req, res) => {
    res.json({ ok: true });
  });
  api.post('/auth/logout', async (req, res) => {
    await auth.logout(bearer(req), caller(req));
    res.status(204).end();
  });
  // Throttled like signing in: it checks the current password, so it must not become a way to guess it.
  api.post('/auth/password', admin, limit(logins), async (req, res) => {
    const { current, next } = parse(ChangePasswordSchema, req.body);
    const token = await auth.setPassword(current, next, caller(req));
    if (!token) throw new HttpError(403, 'wrong_password', 'That is not the current password');
    res.json({ token });
  });
  api.post('/auth/sessions/revoke', admin, async (req, res) => {
    res.json({ ended: await auth.revokeOthers(bearer(req), caller(req)) });
  });

  // ------------------------------------------------------------ settings

  const settingsView = (req: Request): SettingsView => ({
    settings: settings.current,
    passwordSet: auth.required,
    sessions: auth.list(bearer(req)),
    server: { version: VERSION, persistent: !!config.DATABASE_URL, trustProxy: config.TRUST_PROXY },
  });

  api.get('/settings', admin, (req, res) => {
    res.json(settingsView(req));
  });
  api.put('/settings', admin, async (req, res) => {
    const next = parse(AppSettingsSchema, req.body);
    const presets = [...BUILTIN_PRESETS, ...(await store.listPresets())];
    if (next.defaultPresetId && !presets.some((p) => p.id === next.defaultPresetId)) throw new HttpError(400, 'invalid', 'That format no longer exists');
    const before = settings.current;
    const changed = await settings.update(next);
    if (changed.length) audit('settings.changed', caller(req).ip, { changes: Object.fromEntries(changed.map((key) => [key, { from: before[key], to: next[key] }])) });
    res.json(settingsView(req));
  });
  api.get('/audit', admin, async (_req, res) => {
    res.json(await store.listAudit(100));
  });

  // ------------------------------------------------------------ packs

  const getPack = async (req: Request): Promise<Pack> => (await store.getPack(String(req.params.id))) ?? notFound('No such pack');
  const packFile = (pack: Pack): PackFile => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...content } = pack;
    return { format: 'buzzoff.pack', version: 1, pack: content };
  };

  /**
   * A new pack always gets new category and survey ids. Games tell content
   * apart by id, so a duplicated or re-imported pack must not share ids with
   * its source or the two could not be played together.
   */
  const freshIds = (content: PackContent): PackContent => ({
    ...content,
    categories: content.categories.map((cat) => {
      const id = randomId(5);
      return { ...cat, id, clues: cat.clues.map((clue, i) => ({ ...clue, id: `${id}-${i + 1}` })) };
    }),
    surveys: content.surveys.map((survey) => ({ ...survey, id: randomId(5) })),
  });

  api.get('/packs', admin, async (_req, res) => {
    res.json((await store.listPacks()).map(summarizePack));
  });
  api.get('/packs/:id', admin, async (req, res) => {
    res.json(await getPack(req));
  });
  api.post('/packs', admin, async (req, res) => {
    const now = Date.now();
    const pack: Pack = { ...freshIds(parse(PackContentSchema, req.body)), id: randomId(8), createdAt: now, updatedAt: now };
    await store.savePack(pack);
    res.status(201).json(pack);
  });
  api.put('/packs/:id', admin, async (req, res) => {
    const existing = await getPack(req);
    const pack: Pack = { ...parse(PackContentSchema, req.body), id: existing.id, createdAt: existing.createdAt, updatedAt: Date.now() };
    await store.savePack(pack);
    res.json(pack);
  });
  api.delete('/packs/:id', admin, async (req, res) => {
    if (!(await store.deletePack(String(req.params.id)))) notFound('No such pack');
    res.status(204).end();
  });
  api.get('/packs/:id/export', admin, async (req, res) => {
    const pack = await getPack(req);
    const filename = `${pack.title.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'pack'}.buzzoff.json`;
    res.set('Content-Disposition', `attachment; filename="${filename}"`).json(packFile(pack));
  });
  api.post('/packs/import', admin, async (req, res) => {
    const now = Date.now();
    const pack: Pack = { ...freshIds(parse(PackFileSchema, req.body).pack), id: randomId(8), createdAt: now, updatedAt: now };
    await store.savePack(pack);
    res.status(201).json(pack);
  });

  // ------------------------------------------------------------ presets

  api.get('/presets', admin, async (_req, res) => {
    res.json([...BUILTIN_PRESETS, ...(await store.listPresets())]);
  });
  api.post('/presets', admin, async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(60), description: z.string().trim().max(200).default(''), rules: GameRulesSchema }), req.body);
    const preset: Preset = { id: `custom-${randomId(6)}`, builtin: false, ...body, rules: { ...body.rules, name: body.name } };
    await store.savePreset(preset);
    res.status(201).json(preset);
  });
  api.delete('/presets/:id', admin, async (req, res) => {
    if (!(await store.deletePreset(String(req.params.id)))) notFound('No such preset');
    res.status(204).end();
  });

  // ------------------------------------------------------------ media

  // The size limit is read per upload, so changing it in Settings applies to the next file.
  const upload: RequestHandler = (req, res, next) =>
    multer({ storage: multer.memoryStorage(), limits: { fileSize: settings.current.maxUploadMb * 1024 * 1024, files: 1 } }).single('file')(req, res, next);
  api.post('/media', admin, upload, async (req, res) => {
    if (!req.file) throw new HttpError(400, 'invalid', 'No file was uploaded');
    res.status(201).json(await storeMedia(config.MEDIA_DIR, req.file.buffer));
  });

  // ------------------------------------------------------------ games

  api.post('/games', admin, async (req, res) => {
    res.status(201).json(await rooms.create(parse(CreateGameSchema, req.body)));
  });
  api.get('/games/:code', (req, res) => {
    const { state } = roomOf(req);
    const open = state.phase === 'lobby' || (state.phase !== 'finished' && state.rules.lateJoin);
    res.json({
      code: state.code, name: state.rules.name, phase: state.phase, playerCount: state.order.length,
      joinable: open && !state.lobbyLocked && state.order.length < state.rules.maxPlayers,
    } satisfies GameInfo);
  });
  api.post('/games/:code/join', limit(joining), (req, res) => {
    const body = parse(JoinSchema, req.body);
    const room = roomOf(req);
    res.json(room.join(body.name, body.avatar, identify(req, res)));
  });
  api.get('/games/:code/claims/:id', (req, res) => {
    const status = roomOf(req).claimStatus(String(req.params.id), String(req.query.secret ?? ''));
    res.json(status ?? notFound('That request has expired'));
  });
  api.get('/games/:code/host', (req, res) => {
    hostOnly(req);
    res.json({ ok: true });
  });
  api.post('/games/:code/rematch', async (req, res) => {
    await rooms.rematch(hostOnly(req), parse(CreateGameSchema, req.body));
    res.json({ ok: true });
  });
  api.delete('/games/:code', async (req, res) => {
    await rooms.remove(hostOnly(req).code);
    res.status(204).end();
  });

  // ------------------------------------------------------------ history and the leaderboard

  api.get('/history', admin, async (_req, res) => {
    res.json(await results.list(100));
  });
  api.delete('/history/:id', admin, async (req, res) => {
    await results.remove(String(req.params.id));
    res.status(204).end();
  });

  const leaderboard = async (req: Request): Promise<LeaderboardView> => {
    const board = await results.leaderboard();
    const canEdit = auth.allows(bearer(req));
    const key = playerKey(req);
    const profile = key && profileId(key);
    return {
      games: board.games,
      // Which phones and names make up an entry is the host's business only.
      players: canEdit ? board.players : board.players.map((p) => ({ ...p, identities: [] })),
      you: (profile && board.players.find((p) => p.identities.some((i) => i.id === profile))?.id) ?? null,
      canEdit,
    };
  };
  // Open to the host always, and to everyone else when the host has made it public.
  const standings: RequestHandler = (req, _res, next) =>
    next(settings.current.publicLeaderboard || auth.allows(bearer(req)) ? undefined : new HttpError(403, 'private', 'The leaderboard is not public on this server'));
  const identity = z.string().min(1).max(80);

  api.get('/leaderboard', standings, async (req, res) => {
    res.json(await leaderboard(req));
  });
  api.post('/leaderboard/merge', admin, async (req, res) => {
    const { from, into } = parse(z.object({ from: identity, into: identity }), req.body);
    await results.merge(from, into);
    res.json(await leaderboard(req));
  });
  api.post('/leaderboard/separate', admin, async (req, res) => {
    await results.separate(parse(z.object({ id: identity }), req.body).id);
    res.json(await leaderboard(req));
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'No such endpoint')));
  app.use('/api', api);

  app.use('/media', express.static(config.MEDIA_DIR, { immutable: true, maxAge: '365d', fallthrough: false, index: false }));

  // The single-page app: static assets, then index.html for every client-side route.
  const index = path.join(config.WEB_DIR, 'index.html');
  if (existsSync(index)) {
    app.use(express.static(config.WEB_DIR, { index: false, setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } }));
    app.get(/^(?!\/(api|assets|media|socket\.io)\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(index);
    });
  } else {
    log.warn('web app not built; serving the API only', { webDir: config.WEB_DIR });
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let body: ApiError = { error: { code: 'internal', message: 'Something went wrong on the server' } };
    if (err instanceof HttpError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message } };
    } else if (err instanceof GameError) {
      status = err.code === 'content' ? 422 : 409;
      body = { error: { code: err.code, message: err.message } };
    } else if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      status = 413;
      body = { error: { code: 'too_large', message: `Files can be at most ${settings.current.maxUploadMb} MB` } };
    } else if (err instanceof multer.MulterError) {
      status = 400;
      body = { error: { code: 'invalid', message: 'That upload could not be read' } };
    } else if (clientError(err) === 404) {
      status = 404;
      body = { error: { code: 'not_found', message: 'Not found' } };
    } else if (clientError(err)) {
      // Raised by Express itself: an unreadable body, an oversized one, a range a file cannot satisfy.
      status = clientError(err)!;
      body = { error: { code: 'invalid', message: 'That request could not be read' } };
    } else {
      log.error('unhandled request error', { method: req.method, path: req.path, err });
    }
    res.status(status).json(body);
  });

  return app;
}
