/** The leaderboard as players see it, once the host has opened it to them. */
import type { LeaderboardView } from '@buzzoff/shared';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, ApiFailure } from '../lib/api';
import { plural } from '../lib/format';
import { Logo, Notice } from '../ui/kit';
import { Standings } from '../ui/leaderboard';

type Load = { state: 'loading' } | { state: 'private' } | { state: 'failed'; message: string } | { state: 'ready'; view: LeaderboardView };

export function PublicLeaderboard() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.leaderboard().then(
      (view) => !cancelled && setLoad({ state: 'ready', view }),
      (err) => {
        if (cancelled) return;
        const locked = err instanceof ApiFailure && (err.status === 401 || err.status === 403);
        setLoad(locked ? { state: 'private' } : { state: 'failed', message: err instanceof Error ? err.message : 'Something went wrong' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (load.state === 'loading') return <Notice title="Loading…" busy />;
  if (load.state !== 'ready') {
    return (
      <Notice title={load.state === 'private' ? 'The leaderboard is private' : 'Couldn’t load the leaderboard'}>
        <p>{load.state === 'private' ? 'Only the host can see the standings on this server.' : load.message}</p>
        <Link href="/" className="bz-btn bz-btn--primary">
          Join a game
        </Link>
      </Notice>
    );
  }

  const { view } = load;
  return (
    <main className="bz-stage lb-page">
      <header className="lb-page__top">
        <Logo size={24} to="/" />
        <Link href="/" className="bz-btn bz-btn--primary bz-btn--s">
          Join a game
        </Link>
      </header>
      <div className="lb-page__body">
        <div className="lb-page__head bz-rise">
          <p className="bz-eyebrow">All-time</p>
          <h1>Leaderboard</h1>
          <p>{view.players.length ? `${plural(view.players.length, 'player')} across ${plural(view.games, 'game')}.` : 'Nobody is on the board yet.'}</p>
        </div>
        {view.players.length ? (
          <Standings view={view} />
        ) : (
          <div className="bz-card lb-empty bz-rise">
            <span aria-hidden>🏆</span>
            <h2>No games yet</h2>
            <p>The first finished game with two or more players starts the standings.</p>
          </div>
        )}
      </div>
    </main>
  );
}
