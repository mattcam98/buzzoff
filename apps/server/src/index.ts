import { createApp } from './app';
import { resetAdminPassword } from './auth';
import { loadConfig, VERSION } from './config';
import { MemoryStore } from './store/memory';
import { PostgresStore } from './store/postgres';
import { log, setLogLevel } from './util';

const config = loadConfig();
setLogLevel(config.LOG_LEVEL);

if (!config.DATABASE_URL) log.warn('DATABASE_URL is not set: packs, games and settings are kept in memory and lost on restart');

const store = config.DATABASE_URL ? new PostgresStore(config.DATABASE_URL) : new MemoryStore();

// The way back in when the host password is lost:
//   docker compose exec buzzoff node apps/server/dist/index.js reset-admin-password
if (process.argv[2] === 'reset-admin-password') {
  if (!config.DATABASE_URL) {
    console.error('This server has no database, so there is no saved password: restarting it is enough.');
    process.exit(1);
  }
  await store.init();
  await resetAdminPassword(store);
  await store.close();
  console.log('The host password and every signed-in session have been removed.');
  console.log('Restart the server (docker compose restart buzzoff), then set a new password in Settings.');
  console.log('If BUZZOFF_ADMIN_PASSWORD is set, that becomes the password again on restart.');
  process.exit(0);
}
const app = await createApp(config, store);

app.server.listen(config.PORT, () => log.info('BuzzOff is listening', { port: config.PORT, version: VERSION }));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  // Games are flushed to the store before the process exits, so a restart resumes them.
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    log.error('shutdown failed', { err });
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));
