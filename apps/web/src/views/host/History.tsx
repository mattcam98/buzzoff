/** Finished games: who won, the scores, and how everyone did on the buzzer. */
import { accuracy, averageBuzzMs, type GameResult } from '@buzzoff/shared';
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api } from '../../lib/api';
import { fmtMs, fmtPercent, fmtScore } from '../../lib/format';
import { Avatar, Button, toast } from '../../ui/kit';
import { HostShell, PageHead, useShell } from './HostShell';

export function History() {
  return (
    <HostShell>
      <Results />
    </HostShell>
  );
}

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const ms = (value: number | null) => (value === null ? '—' : fmtMs(value));

function Results() {
  const { fail } = useShell();
  const [results, setResults] = useState<GameResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.history().then(
      (list) => !cancelled && setResults([...list].sort((a, b) => b.finishedAt - a.finishedAt)),
      (err) => {
        if (cancelled) return;
        setResults([]);
        setError(fail(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fail]);

  async function remove(result: GameResult) {
    if (!window.confirm(`Remove “${result.name}” from ${when(result.finishedAt)} from the history? It will stop counting towards the leaderboard too.`)) return;
    try {
      await api.deleteResult(result.id);
      setResults((list) => list?.filter((r) => r.id !== result.id) ?? null);
    } catch (err) {
      toast(fail(err), 'error');
    }
  }

  return (
    <>
      <PageHead eyebrow="Archive" title="History" lead="Every finished game, newest first." />
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
      {results === null ? (
        <div className="mg-empty">
          <i className="bz-spinner" aria-hidden />
        </div>
      ) : results.length === 0 && !error ? (
        <div className="bz-card mg-empty bz-rise">
          <span className="mg-empty__icon" aria-hidden>
            🏆
          </span>
          <h2>No winners yet</h2>
          <p>Finish a game and it will be remembered here, bragging rights and all.</p>
          <Link href="/host/new" className="bz-btn bz-btn--primary">
            Host a game
          </Link>
        </div>
      ) : (
        <div className="mg-stack mg-stack--l">
          {results.map((result) => (
            <ResultCard key={result.id} result={result} onRemove={() => void remove(result)} />
          ))}
        </div>
      )}
    </>
  );
}

function ResultCard({ result, onRemove }: { result: GameResult; onRemove: () => void }) {
  const champions = result.players.filter((p) => p.champion);
  return (
    <article className="bz-card mg-result">
      <header className="mg-result__head">
        <div>
          <p className="bz-eyebrow">
            {when(result.finishedAt)} · room {result.code}
          </p>
          <h2>{result.name}</h2>
          <p className="mg-muted">{result.packTitles.join(', ')}</p>
        </div>
        <Button variant="ghost" size="s" icon aria-label={`Remove ${result.name} from history`} title="Remove" onClick={onRemove}>
          ✕
        </Button>
      </header>

      <div className="mg-result__champs">
        {champions.length ? (
          champions.map((p) => (
            <span key={p.name} className="mg-champ">
              <Avatar avatar={p.avatar} size={44} />
              <span>
                <small>Champion</small>
                <strong>{p.name}</strong>
              </span>
            </span>
          ))
        ) : (
          <span className="mg-muted">No champion was crowned.</span>
        )}
        {result.teams && (
          <span className="mg-chips">
            {result.teams.map((t) => (
              <span key={t.name} className="mg-chip">
                {t.name} <em>{fmtScore(t.score)}</em>
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="mg-table-wrap" tabIndex={0} role="group" aria-label={`Player statistics for ${result.name}`}>
        <table className="mg-table">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Score</th>
              <th scope="col">Questions won</th>
              <th scope="col">Correct</th>
              <th scope="col">Fastest registered buzz</th>
              <th scope="col">Average registered buzz</th>
              <th scope="col">Survey points</th>
            </tr>
          </thead>
          <tbody>
            {result.players.map((p) => (
              <tr key={p.name} data-champion={p.champion || undefined}>
                <th scope="row">
                  <Avatar avatar={p.avatar} size={28} dim={p.eliminated} />
                  <span>
                    {p.name}
                    {p.team && <small>{p.team}</small>}
                    {p.eliminated && <small>eliminated</small>}
                  </span>
                </th>
                <td className="bz-num">{fmtScore(p.score)}</td>
                <td>{p.stats.buzzWins}</td>
                <td>{fmtPercent(accuracy(p.stats))}</td>
                <td className="bz-mono">{ms(p.stats.fastestMs)}</td>
                <td className="bz-mono">{ms(averageBuzzMs(p.stats))}</td>
                <td>{p.stats.surveyPoints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mg-result__foot">Buzz times are the server’s record of when each buzz arrived after the buzzers were armed. They include network delay, so they are not reaction times.</p>
    </article>
  );
}
