/** The HTTP API, uploaded media, and the built web app. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AvatarSchema, BUILTIN_PRESETS, CreateGameSchema, GameError, GameRulesSchema, JoinSchema, PackContentSchema, PackFileSchema,
  summarizePack,
  type ApiError, type GameInfo, type Pack, type PackContent, type PackFile, type Preset, type ServerInfo,
} from '@buzzoff/shared';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { VERSION, type Config } from './config';
import { storeMedia } from './media';
import type { Room } from './room';
import type { Rooms } from './rooms';
import type { Store } from './store/types';
import { hmac, Limiter, log, randomId, safeEqual, sha256 } from './util';

const SESSION_MS = 30 * 24 * 3_600_000;

/** Optional password protection for everything a host can do. */
export class AdminAuth {
  private secret: string;
  constructor(
    private password: string | undefined,
    serverSecret: string,
  ) {
    // Changing the password invalidates every session issued under the old one.
    this.secret = sha256(`${serverSecret}:${password ?? ''}`);
  }
  get required() {
    return !!this.password;
  }
  login(password: string): string | null {
    if (!this.password || !safeEqual(sha256(password), sha256(this.password))) return null;
    const expires = String(Date.now() + SESSION_MS);
    return `${expires}.${hmac(this.secret, expires)}`;
  }
  verify(token: string | undefined): boolean {
    if (!this.required) return true;
    const [expires, signature] = (token ?? '').split('.');
    return !!expires && !!signature && Number(expires) > Date.now() && safeEqual(signature, hmac(this.secret, expires));
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const bearer = (req: Request) => req.get('authorization')?.replace(/^Bearer\s+/i, '');

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  throw new HttpError(400, 'invalid', `${where}${issue.message}`);
}

export function createHttp(deps: { config: Config; store: Store; rooms: Rooms; auth: AdminAuth }) {
  const { config, store, rooms, auth } = deps;
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
    next(auth.verify(bearer(req)) ? undefined : new HttpError(401, 'unauthorized', 'Host password required'));

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
    res.json({ version: VERSION, authRequired: auth.required, publicUrl: config.PUBLIC_URL ?? null } satisfies ServerInfo);
  });

  api.post('/auth/login', limit(logins), (req, res) => {
    const { password } = parse(z.object({ password: z.string().max(200) }), req.body);
    const token = auth.login(password);
    if (!token) throw new HttpError(401, 'unauthorized', 'Wrong password');
    res.json({ token });
  });
  api.get('/auth/check', admin, (_req, res) => {
    res.json({ ok: true });
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

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
  api.post('/media', admin, upload.single('file'), async (req, res) => {
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
    res.json(roomOf(req).join(body.name, parse(AvatarSchema, body.avatar)));
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

  // ------------------------------------------------------------ history

  api.get('/history', admin, async (_req, res) => {
    res.json(await store.listResults(100));
  });
  api.delete('/history/:id', admin, async (req, res) => {
    await store.deleteResult(String(req.params.id));
    res.status(204).end();
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
    app.get(/^(?!\/(api|media|socket\.io)\/).*/, (_req, res) => {
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
    } else if (err instanceof multer.MulterError) {
      status = 413;
      body = { error: { code: 'too_large', message: `Files can be at most ${config.MAX_UPLOAD_MB} MB` } };
    } else if ((err as { type?: string })?.type === 'entity.too.large' || (err as { status?: number })?.status === 400) {
      status = (err as { status?: number }).status ?? 400;
      body = { error: { code: 'invalid', message: 'That request could not be read' } };
    } else if ((err as { status?: number })?.status === 404) {
      status = 404;
      body = { error: { code: 'not_found', message: 'Not found' } };
    } else {
      log.error('unhandled request error', { method: req.method, path: req.path, err });
    }
    res.status(status).json(body);
  });

  return app;
}
