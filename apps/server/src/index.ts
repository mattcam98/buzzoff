import { createApp } from './app';
import { loadConfig, VERSION } from './config';
import { MemoryStore } from './store/memory';
import { PostgresStore } from './store/postgres';
import { log, setLogLevel } from './util';

const config = loadConfig();
setLogLevel(config.LOG_LEVEL);

if (!config.DATABASE_URL) log.warn('DATABASE_URL is not set: packs and games are kept in memory and lost on restart');
if (!config.BUZZOFF_ADMIN_PASSWORD) log.warn('BUZZOFF_ADMIN_PASSWORD is not set: anyone who can reach this server can host games and read question packs');

const store = config.DATABASE_URL ? new PostgresStore(config.DATABASE_URL) : new MemoryStore();
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
