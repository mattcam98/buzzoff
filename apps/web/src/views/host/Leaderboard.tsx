/** The all-time standings, with the host's tools for settling who is who. */
import type { LeaderboardEntry, LeaderboardView } from '@buzzoff/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../lib/api';
import { plural } from '../../lib/format';
import { toast } from '../../ui/kit';
import { lookAlikes, Standings, type PlayerTools } from '../../ui/leaderboard';
import { HostShell, PageHead, useShell } from './HostShell';

export function Leaderboard() {
  return (
    <HostShell>
      <Board />
    </HostShell>
  );
}

function Board() {
  const { fail, info } = useShell();
  const [view, setView] = useState<LeaderboardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.leaderboard().then(
      (next) => !cancelled && setView(next),
      (err) => !cancelled && setError(fail(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [fail]);

  /** Make a change to who is who, then show the standings the server sends back. */
  const change = useCallback(
    async (work: Promise<LeaderboardView>, done: string) => {
      try {
        setView(await work);
        toast(done, 'good');
      } catch (err) {
        toast(fail(err), 'error');
      }
    },
    [fail],
  );
  const tools = useMemo<PlayerTools>(
    () => ({
      merge: (from: LeaderboardEntry, into: LeaderboardEntry) => change(api.mergePlayers(from.id, into.id), `${from.name}’s games now count as ${into.name}’s`),
      separate: (identity: string) => change(api.separatePlayer(identity), 'Split into a separate player'),
    }),
    [change],
  );

  const twins = view ? lookAlikes(view.players) : [];
  return (
    <>
      <PageHead
        eyebrow="All-time"
        title="Leaderboard"
        lead={view?.players.length ? `${plural(view.players.length, 'player')} across ${plural(view.games, 'game')}, added up from History.` : 'Every finished game, added up.'}
      >
        {info.publicLeaderboard ? (
          <Link href="/leaderboard" className="bz-btn">
            Players’ view
          </Link>
        ) : (
          <Link href="/host/settings" className="mg-link">
            Only you can see this · open it to players in Settings
          </Link>
        )}
      </PageHead>
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
      {!view && !error && (
        <div className="mg-empty">
          <i className="bz-spinner" aria-hidden />
        </div>
      )}
      {view && view.players.length === 0 && (
        <div className="bz-card mg-empty bz-rise">
          <span className="mg-empty__icon" aria-hidden>
            🏆
          </span>
          <h2>No standings yet</h2>
          <p>The first finished game with two or more players starts the leaderboard. Solo games are practice and don’t count.</p>
          <Link href="/host/new" className="bz-btn bz-btn--primary">
            Host a game
          </Link>
        </div>
      )}
      {view && view.players.length > 0 && (
        <>
          {twins.length > 0 && (
            <p className="mg-note" role="note">
              <strong>More than one player is called {new Intl.ListFormat(undefined, { type: 'disjunction' }).format(twins)}.</strong> If that’s one person on a new phone, open either
              entry and merge them.
            </p>
          )}
          <Standings view={view} tools={tools} />
        </>
      )}
    </>
  );
}
