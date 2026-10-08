/** Wires the store, rooms, HTTP API and sockets into one server. */
import { createServer, type Server as HttpServer } from 'node:http';
import { HandshakeSchema, PackFileSchema, type Pack } from '@buzzoff/shared';
import { Server } from 'socket.io';
import type { Config } from './config';
import { AdminAuth } from './auth';
import { createHttp } from './http';
import type { AppServer } from './room';
import { Rooms } from './rooms';
import { auditTo, Settings } from './settings';
import starterPack from './seed/starter-pack.json' with { type: 'json' };
import type { Store } from './store/types';
import { clientAddress, Limiter, log, randomId } from './util';

export interface App {
  server: HttpServer;
  io: AppServer;
  rooms: Rooms;
  close(): Promise<void>;
}

/** Install the starter pack once. Deleting it later is respected. */
async function seed(store: Store) {
  if (await store.getSetting('seeded')) return;
  const now = Date.now();
  const pack: Pack = { ...PackFileSchema.parse(starterPack).pack, id: `starter-${randomId(4)}`, createdAt: now, updatedAt: now };
  await store.savePack(pack);
  await store.setSetting('seeded', '1');
  log.info('installed starter pack', { categories: pack.categories.length, surveys: pack.surveys.length });
}

export async function createApp(config: Config, store: Store): Promise<App> {
  await store.init();
  await seed(store);
  // Sessions used to be tokens signed with this key; they are now random and stored hashed, so it has no use.
  await store.deleteSetting('server_secret');
  const audit = auditTo(store);
  const settings = await Settings.load(store, config, audit);
  const auth = await AdminAuth.load(store, settings, audit, config.BUZZOFF_ADMIN_PASSWORD);
  if (!auth.required) log.warn('no host password is set: anyone who can reach this server can host games, read question packs and change settings');

  const server = createServer();
  const io: AppServer = new Server(server, {
    // WebSocket only: long-polling would add tens of milliseconds of jitter to every buzz.
    transports: ['websocket'],
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 10_000,
    pingTimeout: 8_000,
  });
  const rooms = new Rooms(io, store, settings);
  await rooms.restore();
  // Socket.IO answers its own path; everything else is the HTTP app's.
  const http = createHttp({ config, store, rooms, auth, settings, audit });
  server.on('request', (req, res) => {
    if (!req.url?.startsWith('/socket.io/')) http(req, res);
  });

  // The burst covers a full room behind one address all reconnecting at once.
  const connections = new Limiter(2, 80);
  io.use((socket, next) => {
    const reject = (message: string) => next(new Error(message));
    // Behind a reverse proxy every socket arrives from the proxy's address, so
    // the limit is keyed on the forwarded client address instead.
    const address = clientAddress(socket.handshake.address, socket.handshake.headers['x-forwarded-for'], config.TRUST_PROXY);
    if (!connections.allow(address)) return reject('rate_limited');
    const handshake = HandshakeSchema.safeParse(socket.handshake.auth);
    if (!handshake.success) return reject('bad_handshake');
    const { role, code, token } = handshake.data;
    const room = rooms.get(code);
    if (!room) return reject('no_room');

    // Each role proves itself here, once; afterwards the socket can only do what its role allows.
    if (role === 'host') {
      if (!room.isHost(token)) return reject('unauthorized');
      socket.data = { role, code: room.code };
    } else if (role === 'player') {
      const playerId = room.playerFor(token);
      if (!playerId) return reject('unauthorized');
      socket.data = { role, code: room.code, playerId };
    } else {
      socket.data = { role, code: room.code };
    }
    next();
  });

  io.on('connection', (socket) => {
    const room = rooms.get(socket.data.code);
    if (!room) return void socket.disconnect(true);
    room.attach(socket);
  });

  return {
    server,
    io,
    rooms,
    async close() {
      // Hang up first, so nothing can be acknowledged after the final save.
      const hungUp = io.close();
      await rooms.shutdown();
      await hungUp;
      await store.close();
    },
  };
}
