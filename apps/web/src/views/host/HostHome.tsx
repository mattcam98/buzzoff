/** The host's starting point: start a game, or get back to one already running. */
import type { GameInfo } from '@buzzoff/shared';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, ApiFailure } from '../../lib/api';
import { plural } from '../../lib/format';
import { storage, type HostedGame } from '../../lib/storage';
import { Button, toast } from '../../ui/kit';
import { HostShell, useShell } from './HostShell';

export function HostHome() {
  return (
    <HostShell>
      <Dashboard />
    </HostShell>
  );
}

interface LiveGame extends HostedGame {
  info: GameInfo;
}

const PHASE_LABEL: Record<GameInfo['phase'], string> = { lobby: 'In the lobby', round: 'In play', standings: 'Between rounds', finished: 'Finished' };

/** Keep only the games this browser still holds a working host key for. */
async function loadGames(): Promise<LiveGame[]> {
  const checked = await Promise.all(
    storage.hostedGames().map(async (game) => {
      try {
        await api.checkHost(game.code);
        return { ...game, info: await api.game(game.code) };
      } catch (err) {
        // Expired or replaced rooms are forgotten; a network blip is not a reason to forget.
        if (err instanceof ApiFailure && (err.status === 404 || err.status === 403)) storage.removeHostedGame(game.code);
        return null;
      }
    }),
  );
  return checked.filter((g) => g !== null);
}

function Dashboard() {
  const { info, fail } = useShell();
  const [games, setGames] = useState<LiveGame[] | null>(null);
  const [packCount, setPackCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadGames().then((list) => !cancelled && setGames(list));
    api.packs().then(
      (packs) => !cancelled && setPackCount(packs.length),
      (err) => void fail(err),
    );
    return () => {
      cancelled = true;
    };
  }, [fail]);

  async function remove(game: LiveGame) {
    if (!window.confirm(`End game ${game.code} for everyone? This cannot be undone.`)) return;
    try {
      await api.deleteGame(game.code);
      storage.removeHostedGame(game.code);
      storage.setGameSetup(game.code, null);
      setGames((list) => list?.filter((g) => g.code !== game.code) ?? null);
    } catch (err) {
      toast(fail(err), 'error');
    }
  }

  return (
    <>
      <section className="mg-hero bz-rise">
        <div>
          <p className="bz-eyebrow">Host</p>
          <h1>
            Lights up.
            <br />
            <span>Who’s playing?</span>
          </h1>
          <p className="mg-hero__lead">Put the room code on the big screen, let everyone join from their phone, and run the show from here.</p>
          <Link href="/host/new" className="bz-btn bz-btn--primary bz-btn--l">
            Host a game
          </Link>
        </div>
        <div className="mg-hero__art" aria-hidden>
          <i />
          <i />
          <i />
        </div>
      </section>

      {!info.authRequired && (
        <p className="mg-note" role="note">
          <strong>No host password is set.</strong> Anyone who can reach this server can host games and read your question packs. Set{' '}
          <code>BUZZOFF_ADMIN_PASSWORD</code> to lock hosting down.
        </p>
      )}

      <section className="mg-section">
        <div className="mg-section__head">
          <h2>Your games</h2>
        </div>
        {games === null ? (
          <div className="mg-empty mg-empty--inline">
            <i className="bz-spinner" aria-hidden />
          </div>
        ) : games.length === 0 ? (
          <div className="bz-card mg-empty mg-empty--inline">
            <p>No games on the go. The stage is all yours.</p>
          </div>
        ) : (
          <ul className="mg-games">
            {games.map((game) => (
              <li key={game.code} className="bz-card mg-game">
                <span className="mg-game__code">{game.code}</span>
                <div className="mg-game__info">
                  <strong>{game.info.name}</strong>
                  <span>
                    <span className={game.info.phase === 'finished' ? 'bz-pill' : 'bz-pill bz-pill--good'}>{PHASE_LABEL[game.info.phase]}</span>{' '}
                    {plural(game.info.playerCount, 'player')}
                  </span>
                </div>
                <div className="mg-game__actions">
                  <Link href={`/host/game/${game.code}`} className="bz-btn bz-btn--primary bz-btn--s">
                    Open console
                  </Link>
                  <a href={`/tv/${game.code}`} target="_blank" rel="noreferrer" className="bz-btn bz-btn--ghost bz-btn--s">
                    Open TV ↗
                  </a>
                  <Button variant="ghost" size="s" icon aria-label={`End game ${game.code}`} title="End game" onClick={() => void remove(game)}>
                    ✕
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mg-doors">
        <Link href="/host/packs" className="bz-card mg-door">
          <span className="mg-door__icon" aria-hidden>
            🗂️
          </span>
          <span>
            <strong>Question packs</strong>
            <small>{packCount === null ? 'Write, import and edit your questions.' : `${plural(packCount, 'pack')} ready. Write, import and edit.`}</small>
          </span>
          <span aria-hidden>→</span>
        </Link>
        <Link href="/host/history" className="bz-card mg-door">
          <span className="mg-door__icon" aria-hidden>
            🏆
          </span>
          <span>
            <strong>History</strong>
            <small>Past winners, scores and buzzer stats.</small>
          </span>
          <span aria-hidden>→</span>
        </Link>
      </section>
    </>
  );
}
