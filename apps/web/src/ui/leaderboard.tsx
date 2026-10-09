/**
 * The all-time standings and one player's record. The host's page and the page players see are
 * both this; the host's adds the tools for saying who is who.
 */
import {
  accuracy, averageBuzzMs, averageScore, firstInRate, isNameIdentity, LENSES, nameKey, rankPlayers, winRate,
  type LeaderboardEntry, type LeaderboardView, type Lens, type Ranking,
} from '@buzzoff/shared';
import { useMemo, useState, type ReactNode } from 'react';
import { fmtDay, fmtMs, fmtPercent, fmtScore, ordinal, plural } from '../lib/format';
import { Avatar, Button, Modal } from './kit';
import '../styles/leaderboard.css';

/** What the host can do about two entries being one person, or one entry being two. Each resolves once the standings are up to date. */
export interface PlayerTools {
  merge: (from: LeaderboardEntry, into: LeaderboardEntry) => Promise<void>;
  separate: (identity: string) => Promise<void>;
}

interface Column {
  label: string;
  value: (e: LeaderboardEntry) => string;
}

const ms = (value: number | null) => (value === null ? '–' : fmtMs(value));
const whole = (value: number | null) => (value === null ? '–' : fmtScore(Math.round(value)));

/** Each way of ranking shows the measure it ranks by first, then two that put it in context. */
const LENS_VIEW: Record<Lens, { label: string; columns: [Column, Column, Column]; note?: string }> = {
  wins: {
    label: 'Wins',
    columns: [
      { label: 'Wins', value: (e) => String(e.wins) },
      { label: 'Played', value: (e) => String(e.games) },
      { label: 'Win rate', value: (e) => fmtPercent(winRate(e)) },
    ],
  },
  winRate: {
    label: 'Win rate',
    columns: [
      { label: 'Win rate', value: (e) => fmtPercent(winRate(e)) },
      { label: 'Wins', value: (e) => String(e.wins) },
      { label: 'Played', value: (e) => String(e.games) },
    ],
  },
  points: {
    label: 'Points',
    columns: [
      { label: 'Points', value: (e) => fmtScore(e.points) },
      { label: 'Average', value: (e) => whole(averageScore(e)) },
      { label: 'Best', value: (e) => fmtScore(e.best) },
    ],
    note: 'Formats score differently, so points say more about how much someone has played than how well.',
  },
  accuracy: {
    label: 'Accuracy',
    columns: [
      { label: 'Correct', value: (e) => fmtPercent(accuracy(e.stats)) },
      { label: 'Right', value: (e) => String(e.stats.correct) },
      { label: 'Wrong', value: (e) => String(e.stats.incorrect) },
    ],
  },
  buzzer: {
    label: 'Buzzer',
    columns: [
      { label: 'First in', value: (e) => fmtPercent(firstInRate(e.stats)) },
      { label: 'Buzzes won', value: (e) => String(e.stats.buzzWins) },
      { label: 'Avg buzz', value: (e) => ms(averageBuzzMs(e.stats)) },
    ],
    note: 'First in is the share of a player’s buzzes that reached the server before anyone else’s. Buzz times include network delay, so they’re not reaction times.',
  },
};

const UNIT = { game: 'game', answer: 'judged answer', buzz: 'buzz' } as const;
const needs = ({ minimum, unit }: Ranking) => plural(minimum, UNIT[unit], unit === 'buzz' ? 'buzzes' : undefined);

/** The last few results as a row of dots, oldest first, so the newest sits where the eye ends up. */
function Form({ entry }: { entry: LeaderboardEntry }) {
  const games = entry.recent.slice(0, 5).reverse();
  return (
    <span className="lb-form" role="img" aria-label={`Last ${plural(games.length, 'game')}: ${games.map((g) => (g.won ? 'won' : ordinal(g.place))).join(', ')}`}>
      {games.map((g) => (
        <i key={g.finishedAt} data-won={g.won || undefined} />
      ))}
    </span>
  );
}

export function Standings({ view, tools }: { view: LeaderboardView; tools?: PlayerTools }) {
  const [lens, setLens] = useState<Lens>('wins');
  const [openId, setOpenId] = useState<string | null>(null);
  const rankings = useMemo(() => Object.fromEntries(LENSES.map((l) => [l, rankPlayers(view.players, l)])) as Record<Lens, Ranking>, [view.players]);
  const ranking = rankings[lens];
  const { columns, note } = LENS_VIEW[lens];
  const open = view.players.find((p) => p.id === openId) ?? null;
  const firstUnranked = ranking.rows.findIndex((r) => r.rank === null);

  return (
    <div className="lb">
      <div className="lb-lenses" role="radiogroup" aria-label="Rank by">
        {LENSES.map((l) => (
          <button key={l} type="button" role="radio" aria-checked={l === lens} onClick={() => setLens(l)}>
            {LENS_VIEW[l].label}
          </button>
        ))}
      </div>

      <div className="bz-card lb-board">
        <div className="lb-cols" aria-hidden>
          <span>#</span>
          <span>Player</span>
          {columns.map((c) => (
            <span key={c.label}>{c.label}</span>
          ))}
        </div>
        <ol className="lb-list">
          {ranking.rows.map(({ entry, rank, tied }, i) => (
            <li key={entry.id} data-you={entry.id === view.you || undefined} data-unranked={rank === null || undefined}>
              {i === firstUnranked && (
                <p className="lb-cut">
                  <span>Ranked after {needs(ranking)}</span>
                </p>
              )}
              <button type="button" className="lb-row" onClick={() => setOpenId(entry.id)}>
                <span className="lb-rank bz-num" data-medal={rank !== null && rank <= 3 ? rank : undefined}>
                  <span className="sr-only">{rank === null ? 'Not ranked yet' : `${tied ? 'Tied ' : ''}${ordinal(rank)}`}</span>
                  <span aria-hidden>{rank === null ? '–' : `${tied ? '=' : ''}${rank}`}</span>
                </span>
                <Avatar avatar={entry.avatar} size={40} />
                <span className="lb-who">
                  <span className="lb-name">
                    <strong>{entry.name}</strong>
                    {entry.id === view.you && <span className="bz-pill bz-pill--cyan">You</span>}
                  </span>
                  <Form entry={entry} />
                </span>
                {columns.map((c) => (
                  <span key={c.label} className="lb-stat bz-num">
                    <span className="sr-only">{c.label} </span>
                    {c.value(entry)}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <p className="lb-note">
        {note && <>{note} </>}
        {firstUnranked !== -1 && <>A rate means little after a game or two, so this ranking starts at {needs(ranking)}. </>}
        Every finished game with two or more players counts. Tap a player for their full record.
      </p>

      {open && <PlayerSheet entry={open} view={view} rankings={rankings} tools={tools} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** Entries that look like one person on two phones: the same name, counted apart. Something for the host to settle. */
export function lookAlikes(players: LeaderboardEntry[]): string[] {
  const named = new Map<string, string[]>();
  for (const { name } of players) named.set(nameKey(name), [...(named.get(nameKey(name)) ?? []), name]);
  return [...named.values()].filter((names) => names.length > 1).map(([name]) => name);
}

function Tile({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="lb-tile">
      <dt>{label}</dt>
      <dd>
        <span className="bz-num">{value}</span>
        {detail && <small>{detail}</small>}
      </dd>
    </div>
  );
}

function PlayerSheet({ entry, view, rankings, tools, onClose }: {
  entry: LeaderboardEntry;
  view: LeaderboardView;
  rankings: Record<Lens, Ranking>;
  tools?: PlayerTools;
  onClose: () => void;
}) {
  const { stats } = entry;
  const judged = stats.correct + stats.incorrect;
  // Where they stand on each measure they have played enough to be ranked on.
  const standing = LENSES.flatMap((lens) => {
    const row = rankings[lens].rows.find((r) => r.entry.id === entry.id);
    return row && row.rank !== null ? [{ lens, rank: row.rank, tied: row.tied }] : [];
  });

  return (
    <Modal
      title={`${entry.name}’s record`}
      className="lb-sheet"
      onClose={onClose}
      heading={
        <header className="lb-sheet__head">
          <Avatar avatar={entry.avatar} size={64} />
          <div>
            <h2>
              {entry.name}
              {entry.id === view.you && <span className="bz-pill bz-pill--cyan">You</span>}
            </h2>
            <p>
              {entry.aliases.length > 0 && <>Also played as {new Intl.ListFormat(undefined, { type: 'conjunction' }).format(entry.aliases)} · </>}
              Last played {fmtDay(entry.lastPlayedAt)}
            </p>
          </div>
          <Button variant="ghost" size="s" icon aria-label="Close" onClick={onClose}>
            ✕
          </Button>
        </header>
      }
    >
      {standing.length > 0 && (
        <ul className="lb-standing" aria-label="Where they stand">
          {standing.map(({ lens, rank, tied }) => (
            <li key={lens} data-medal={rank <= 3 ? rank : undefined}>
              <b className="bz-num">
                {tied && '='}
                {ordinal(rank)}
              </b>{' '}
              {LENS_VIEW[lens].label.toLowerCase()}
            </li>
          ))}
        </ul>
      )}

      <dl className="lb-tiles">
        <Tile label="Games played" value={entry.games} />
        <Tile label="Wins" value={entry.wins} detail={`${fmtPercent(winRate(entry))} of games`} />
        <Tile label="Total points" value={fmtScore(entry.points)} />
        <Tile label="Average score" value={whole(averageScore(entry))} />
        <Tile label="Best score" value={fmtScore(entry.best)} />
        <Tile label="Correct answers" value={fmtPercent(accuracy(stats))} detail={judged ? `${stats.correct} of ${judged}` : 'none judged yet'} />
        <Tile label="Buzzes won" value={stats.buzzWins} detail={stats.buzzes ? `first in on ${fmtPercent(firstInRate(stats))}` : 'never buzzed'} />
        <Tile label="Average buzz" value={<span className="bz-mono">{ms(averageBuzzMs(stats))}</span>} />
        <Tile label="Fastest buzz" value={<span className="bz-mono">{ms(stats.fastestMs)}</span>} />
        {stats.surveyPoints > 0 && <Tile label="Survey points" value={fmtScore(stats.surveyPoints)} />}
      </dl>

      <section className="lb-sheet__part">
        <h3>Recent games</h3>
        <ol className="lb-games">
          {entry.recent.map((g) => (
            <li key={g.finishedAt} data-won={g.won || undefined}>
              <span className="lb-games__place bz-num">{ordinal(g.place)}</span>
              <span className="lb-games__what">
                <strong>{g.name}</strong>
                <small>
                  {fmtDay(g.finishedAt)} · {g.of} players
                  {nameKey(g.playedAs) !== nameKey(entry.name) && <> · as {g.playedAs}</>}
                </small>
              </span>
              <span className="bz-num">{fmtScore(g.score)}</span>
            </li>
          ))}
        </ol>
        {entry.games > entry.recent.length && <p className="lb-note">Showing the latest {entry.recent.length} of {entry.games}.</p>}
      </section>

      {tools && <SamePerson entry={entry} others={view.players.filter((p) => p.id !== entry.id)} tools={tools} />}
    </Modal>
  );
}

/** The host's say on identity: fold another entry into this one, or take out something that was folded in. */
function SamePerson({ entry, others, tools }: { entry: LeaderboardEntry; others: LeaderboardEntry[]; tools: PlayerTools }) {
  const [fromId, setFromId] = useState('');
  const [busy, setBusy] = useState(false);
  const from = others.find((p) => p.id === fromId);
  // Whatever else is counted as this player: another phone, or games matched by name alone.
  const parts = entry.identities.filter((i) => i.id !== entry.id);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    await work().finally(() => setBusy(false));
  };

  return (
    <section className="lb-sheet__part">
      <h3>Same person, counted twice?</h3>
      <p className="lb-note">
        Players are recognised by their phone, whatever name they type. A new phone or a cleared browser starts a new entry. Merge that entry into this one and its games
        count here.
      </p>
      {others.length > 0 && (
        <div className="lb-merge">
          <select className="bz-select" aria-label={`Player to merge into ${entry.name}`} value={fromId} onChange={(e) => setFromId(e.target.value)}>
            <option value="">Choose a player…</option>
            {[...others].sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {plural(p.games, 'game')}
              </option>
            ))}
          </select>
          <Button disabled={!from || busy} onClick={() => from && void run(() => tools.merge(from, entry)).then(() => setFromId(''))}>
            Merge into {entry.name}
          </Button>
        </div>
      )}
      {parts.length > 0 && (
        <ul className="lb-parts">
          {parts.map((part) => (
            <li key={part.id}>
              <span>
                <strong>{part.name}</strong>
                <small>
                  {isNameIdentity(part.id) ? 'matched by name' : 'another phone'} · {plural(part.games, 'game')}
                </small>
              </span>
              <Button size="s" disabled={busy} onClick={() => void run(() => tools.separate(part.id))}>
                Separate
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
