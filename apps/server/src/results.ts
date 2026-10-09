/**
 * Finished games, and the leaderboard worked out from them. Everything that adds or removes a
 * result comes through here, which is what lets the standings be computed once and kept until
 * the next change rather than rebuilt from the whole history on every request.
 */
import { buildLeaderboard, GameError, mergeProblem, type GameResult, type Leaderboard, type PlayerLinks } from '@buzzoff/shared';
import type { Store } from './store/types';
import { log } from './util';

const LINKS_KEY = 'player_links';

export class Results {
  private board: Promise<Leaderboard> | null = null;
  private changes: Promise<void> = Promise.resolve();

  private constructor(
    private store: Store,
    private links: PlayerLinks,
  ) {}

  static async load(store: Store): Promise<Results> {
    let links: PlayerLinks = {};
    try {
      links = JSON.parse((await store.getSetting(LINKS_KEY)) ?? '{}');
    } catch (err) {
      log.error('saved player links could not be read; players are matched as if there were none', { err });
    }
    return new Results(store, links);
  }

  /**
   * Make one change once the changes asked for before it are done, and forget the standings they
   * were worked out from. The store answers each request in its own time, so without the queue a
   * game whose ending is undone straight away could have its result removed before it was saved.
   */
  private change(work: () => Promise<void>): Promise<void> {
    const done = this.changes.then(work).then(() => void (this.board = null));
    this.changes = done.catch(() => undefined);
    return done;
  }

  list(limit: number): Promise<GameResult[]> {
    return this.store.listResults(limit);
  }

  save(result: GameResult) {
    return this.change(() => this.store.saveResult(result));
  }

  remove(id: string) {
    return this.change(() => this.store.deleteResult(id));
  }

  leaderboard(): Promise<Leaderboard> {
    if (this.board) return this.board;
    const board: Promise<Leaderboard> = this.store.listResults().then((results) => buildLeaderboard(results, this.links));
    // A failed read is not worth remembering.
    board.catch(() => this.board === board && (this.board = null));
    return (this.board = board);
  }

  private async relink(links: PlayerLinks) {
    await this.store.setSetting(LINKS_KEY, JSON.stringify(links));
    this.links = links;
  }

  /** Count everything `from` has played as `into`'s. Both are ids of entries on the leaderboard. */
  merge(from: string, into: string) {
    return this.change(async () => {
      const problem = mergeProblem(await this.store.listResults(), this.links, from, into);
      if (problem) throw new GameError('cannot_merge', problem);
      await this.relink({ ...this.links, [from]: into });
    });
  }

  /** Make an identity its own player again, whether the host merged it or its name matched on its own. */
  separate(id: string) {
    return this.change(() => this.relink({ ...this.links, [id]: id }));
  }
}
