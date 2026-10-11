/**
 * When each category and survey was last played on this server. Games are dealt what has rested
 * longest (see `assembleRounds`), so a second game in an evening, or next week's, does not ask
 * what the last one asked until the packs have been played right through.
 */
import type { Played } from '@buzzoff/shared';
import type { Store } from './store/types';
import { log } from './util';

const KEY = 'content_played';
/** Far more than any server's packs hold; ids of content that was since deleted fall off the end. */
const KEEP = 5000;

export class PlayLog {
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private store: Store,
    private played: Played,
  ) {}

  static async load(store: Store): Promise<PlayLog> {
    let played: Played = {};
    try {
      played = JSON.parse((await store.getSetting(KEY)) ?? '{}');
    } catch (err) {
      log.error('the record of played questions could not be read; every question counts as fresh', { err });
    }
    return new PlayLog(store, played);
  }

  get current(): Played {
    return this.played;
  }

  /** Note that these were played just now. It counts at once; the write follows, in order. */
  record(ids: string[], at = Date.now()) {
    if (!ids.length) return;
    const entries = Object.entries({ ...this.played, ...Object.fromEntries(ids.map((id) => [id, at])) });
    this.played = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, KEEP));
    const saved = JSON.stringify(this.played);
    this.writes = this.writes.then(() => this.store.setSetting(KEY, saved)).catch((err) => log.error('could not save the record of played questions', { err }));
  }

  /** Resolves once everything recorded so far has been written. */
  flush(): Promise<void> {
    return this.writes;
  }
}
