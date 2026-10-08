/**
 * Settings the administrator changes from inside the app. They live in the
 * database as one validated document and take effect the moment they are
 * saved; everything that reads them reads `current`.
 */
import { AppSettingsSchema, publicOrigin, SETTINGS_LIMITS, type AppSettings, type AuditAction } from '@buzzoff/shared';
import type { Config } from './config';
import type { Store } from './store/types';
import { log } from './util';

const SETTINGS_KEY = 'app';

/** Record something security-relevant. It never throws: a failed write is logged and the action carries on. */
export type Audit = (action: AuditAction, ip: string, detail?: Record<string, unknown>) => void;

export const auditTo =
  (store: Store): Audit =>
  (action, ip, detail = {}) => {
    log.info('audit', { action, ip, ...detail });
    store.addAudit({ at: Date.now(), action, ip, detail }).catch((err) => log.error('could not write audit log', { action, err }));
  };

/**
 * Settings for a server that has none saved yet. Values that used to be
 * environment variables are carried over, so upgrading changes nothing; a
 * value that would not be accepted today is dropped with a warning.
 */
function fromEnvironment(config: Config): { settings: AppSettings; imported: string[] } {
  const settings = AppSettingsSchema.parse({});
  const imported: string[] = [];
  const number = (raw: string | undefined, key: 'roomTtlHours' | 'maxUploadMb', name: string) => {
    if (raw === undefined) return;
    const { min, max } = SETTINGS_LIMITS[key];
    const value = Math.round(Number(raw));
    if (!(value >= min && value <= max)) return log.warn(`${name} is not usable and was not imported`, { value: raw });
    settings[key] = value;
    imported.push(name);
  };
  if (config.PUBLIC_URL !== undefined) {
    const origin = publicOrigin(config.PUBLIC_URL);
    if (origin) imported.push('PUBLIC_URL');
    else log.warn('PUBLIC_URL is not an http(s) address and was not imported', { value: config.PUBLIC_URL });
    settings.publicUrl = origin;
  }
  number(config.ROOM_TTL_HOURS, 'roomTtlHours', 'ROOM_TTL_HOURS');
  number(config.MAX_UPLOAD_MB, 'maxUploadMb', 'MAX_UPLOAD_MB');
  // Finished games were never kept longer than idle ones.
  settings.finishedTtlHours = Math.min(settings.finishedTtlHours, settings.roomTtlHours);
  return { settings, imported };
}

export class Settings {
  private constructor(
    private store: Store,
    public current: AppSettings,
  ) {}

  static async load(store: Store, config: Config, audit: Audit): Promise<Settings> {
    const saved = await store.getSetting(SETTINGS_KEY);
    if (saved !== null) {
      const legacy = (['PUBLIC_URL', 'ROOM_TTL_HOURS', 'MAX_UPLOAD_MB'] as const).filter((name) => config[name] !== undefined);
      if (legacy.length) log.info('ignored environment variables that are now managed in Settings; they can be removed from .env', { variables: legacy });
      try {
        // Parsing fills in any setting added since this document was saved.
        return new Settings(store, AppSettingsSchema.parse(JSON.parse(saved)));
      } catch (err) {
        log.error('saved settings could not be read; using defaults until they are saved again', { err });
        return new Settings(store, AppSettingsSchema.parse({}));
      }
    }
    const { settings, imported } = fromEnvironment(config);
    await store.setSetting(SETTINGS_KEY, JSON.stringify(settings));
    if (imported.length) audit('settings.imported', 'server', { from: imported });
    return new Settings(store, settings);
  }

  /** Save validated settings. Returns the names of the settings that changed. */
  async update(next: AppSettings): Promise<(keyof AppSettings)[]> {
    const changed = (Object.keys(next) as (keyof AppSettings)[]).filter((key) => next[key] !== this.current[key]);
    if (!changed.length) return changed;
    await this.store.setSetting(SETTINGS_KEY, JSON.stringify(next));
    this.current = next;
    return changed;
  }
}
