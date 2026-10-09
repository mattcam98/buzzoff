/**
 * The shared screen. It only ever shows what the room is allowed to see: it
 * connects with no credentials and receives the public view.
 */
import { accuracy, normalizeRoomCode, ROOM_CODE_LENGTH, type PlayerStats, type PublicPlayer, type PublicView } from '@buzzoff/shared';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { api } from '../lib/api';
import { useConnection, type Snapshot } from '../lib/connection';
import { fmtMs, fmtPercent, joinAddress, ordinal, placings, playerMap, plural } from '../lib/format';
import { useFullscreen, useGameEvents, useHotkeys, useRecentInput, useWakeLock } from '../lib/hooks';
import { duckMusic, moodFor, setMusic } from '../lib/music';
import { audioReady, play, soundFor, unlockAudio } from '../lib/sound';
import { FinalSecondsTick, roundBlurb, Score } from '../ui/game';
import { Avatar, Button, Confetti, cx, Logo, Notice } from '../ui/kit';
import { columnsFor, FastMoneyScene, FinalScene, inRows, rowsOf, TriviaScene, useFit } from './tv/Scenes';
import '../styles/game.css';
import '../styles/tv.css';

export interface SceneProps {
  pub: PublicView;
  snap: Snapshot;
  players: Record<string, PublicPlayer>;
}

export function TvCodeEntry() {
  const [, navigate] = useLocation();
  const [code, setCode] = useState('');
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === ROOM_CODE_LENGTH) navigate(`/tv/${code}`);
  };
  return (
    <Notice title="Put a game on this screen">
      <p>Enter the room code from the host’s dashboard.</p>
      <form onSubmit={go} style={{ display: 'grid', gap: 12, width: 'min(100%, 280px)' }}>
        <input
          className="bz-input"
          style={{ textAlign: 'center', fontSize: '2rem', fontWeight: 800, letterSpacing: '0.3em', textTransform: 'uppercase' }}
          value={code}
          onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
          aria-label="Room code"
          autoFocus
        />
        <Button type="submit" variant="primary" size="l" disabled={code.length !== ROOM_CODE_LENGTH}>
          Show game
        </Button>
      </form>
    </Notice>
  );
}

export function Tv({ code }: { code: string }) {
  const { conn, snap } = useConnection('display', code);
  const [sound, setSound] = useState(audioReady());
  const [confetti, setConfetti] = useState(0);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const full = useFullscreen();
  const inUse = useRecentInput();
  useWakeLock();
  useHotkeys((key) => key === 'f' && full.supported && full.toggle());

  useEffect(() => {
    api.info().then((info) => setPublicUrl(info.publicUrl), () => undefined);
  }, []);

  useGameEvents(conn, (event) => {
    const name = soundFor(event);
    if (name) {
      play(name);
      duckMusic(name);
    }
    const celebrate = event.type === 'game.finished' || (event.type === 'fm.result' && event.won) || (event.type === 'cue' && event.name === 'confetti');
    if (celebrate) setConfetti((n) => n + 1);
  });

  const { pub } = snap;
  // The music follows the game, and stops with the screen.
  const mood = sound && pub && snap.status !== 'rejected' && snap.status !== 'ended' ? moodFor(pub) : null;
  useEffect(() => setMusic(mood), [mood]);
  useEffect(() => () => setMusic(null), []);

  if (snap.status === 'rejected') {
    return (
      <Notice title="No game with that code">
        <p>
          <strong>{code}</strong> isn’t a live game. Check the code on the host’s dashboard.
        </p>
      </Notice>
    );
  }
  if (snap.status === 'ended') return <Notice title="This game has ended" />;
  if (!pub) return <Notice title="Tuning in…" busy />;

  const enableSound = () => {
    void unlockAudio().then(() => play('join'));
    setSound(true);
  };

  return (
    // A click anywhere turns the sound on, and wakes it again if the browser has since put it to sleep.
    <div className="bz-stage tv" data-phase={pub.phase} data-music={mood ?? 'off'} data-idle={(full.on && !inUse) || undefined} onClick={sound ? unlockAudio : enableSound}>
      <TvContent pub={pub} snap={snap} publicUrl={publicUrl} />
      {pub.paused && (
        <div className="tv-overlay" role="status">
          <div className="bz-pop">
            <span className="bz-eyebrow">Stand by</span>
            <h2>Paused</h2>
          </div>
        </div>
      )}
      {snap.status !== 'online' && <div className="tv-offline">Reconnecting…</div>}
      {/* The screen itself takes the click; the button says so, and gives the keyboard something to press. */}
      {!sound && <button className="tv-sound">🔊 Click anywhere to turn sound on</button>}
      {/* Offered while someone is at the mouse or keyboard, and until the screen has had its first click; then it gets out of the way. */}
      {full.supported && (inUse || !sound) && (
        <button className="tv-full" onClick={full.toggle} title="Press F">
          <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden>
            <path d={full.on ? 'M6 2v4H2M10 2v4h4M14 10h-4v4M2 10h4v4' : 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {full.on ? 'Exit full screen' : 'Full screen'}
        </button>
      )}
      <Confetti burst={confetti} />
    </div>
  );
}

function TvContent({ pub, snap, publicUrl }: { pub: PublicView; snap: Snapshot; publicUrl: string | null }) {
  const players = useMemo(() => playerMap(pub), [pub]);
  const props: SceneProps = { pub, snap, players };
  const round = pub.round;
  const join = joinAddress(publicUrl);

  if (pub.phase === 'lobby') return <Lobby pub={pub} join={join} />;
  if (pub.phase === 'finished') return <Finale {...props} />;

  const title = pub.phase === 'standings' ? 'Standings' : (round?.title ?? '');
  return (
    <>
      <FinalSecondsTick pub={pub} snap={snap} />
      <header className="tv-top">
        <Logo />
        <div className="tv-top__title">
          <span className="bz-eyebrow">
            {pub.name} · Round {pub.roundIndex + 1} of {pub.rounds.length}
          </span>
          <strong>{title}</strong>
        </div>
        <div className="tv-top__join">
          <span>{join.label}</span>
          <b>{pub.code}</b>
        </div>
      </header>
      <main className="tv-main" key={`${pub.phase}-${pub.roundIndex}-${round?.stage === 'intro' || round?.stage === 'roll' ? round.stage : 'play'}`}>
        {pub.phase === 'standings' ? (
          <Standings {...props} />
        ) : !round ? null : round.stage === 'intro' ? (
          <RoundIntro pub={pub} />
        ) : round.mode === 'trivia' ? (
          <TriviaScene {...props} round={round} />
        ) : round.mode === 'fastMoney' ? (
          <FastMoneyScene {...props} round={round} />
        ) : (
          <FinalScene {...props} round={round} />
        )}
      </main>
      <Podiums {...props} />
    </>
  );
}

// ---------------------------------------------------------------- lobby

function Lobby({ pub, join }: { pub: PublicView; join: { url: string; label: string } }) {
  const [qr, setQr] = useState<string | null>(null);
  const link = `${join.url}/join/${pub.code}`;
  useEffect(() => {
    QRCode.toDataURL(link, { margin: 1, width: 640, color: { dark: '#0d0b22', light: '#ffffff' } }).then(setQr, () => setQr(null));
  }, [link]);
  const ready = pub.players.filter((p) => p.ready).length;
  const list = useFit<HTMLUListElement>();

  return (
    <main className="tv-lobby">
      <section className="tv-lobby__join">
        <Logo />
        <p className="tv-lobby__step">
          <span>1</span> On your phone, go to
        </p>
        <p className="tv-lobby__url">{join.label}</p>
        <p className="tv-lobby__step">
          <span>2</span> Enter the room code
        </p>
        <div className="tv-lobby__code" aria-label={`Room code ${pub.code.split('').join(' ')}`}>
          {pub.code.split('').map((ch, i) => (
            <b key={i} style={{ animationDelay: `${i * 90}ms` }}>
              {ch}
            </b>
          ))}
        </div>
        <div className="tv-lobby__qr">
          {qr && <img src={qr} alt="QR code to join this game" />}
          <span>or scan to jump straight in</span>
        </div>
      </section>

      <section className="tv-lobby__room">
        <header>
          <div>
            <span className="bz-eyebrow">{pub.packTitles.join(' + ')}</span>
            <h1>{pub.name}</h1>
          </div>
          <p>
            <b className="bz-num">{pub.players.length}</b> {pub.players.length === 1 ? 'player' : 'players'}
            {ready > 0 && <> · {ready} ready</>}
          </p>
        </header>
        {pub.players.length === 0 ? (
          <div className="tv-lobby__empty">
            <i className="bz-spinner" aria-hidden />
            <p>Waiting for the first contestant…</p>
          </div>
        ) : (
          // Bigger for a few, smaller for many, and smaller again (useFit) for as long as the whole room is not on the screen.
          <ul ref={list} className="tv-lobby__players" data-many={pub.players.length > 10 || undefined} data-few={pub.players.length <= 6 || undefined}>
            {pub.players.map((p) => (
              <li key={p.id} data-offline={!p.connected || undefined}>
                <Avatar avatar={p.avatar} size="3.4em" dim={!p.connected} />
                <strong>{p.name}</strong>
                {pub.teams && p.teamId !== null && <small>{pub.teams[p.teamId]?.name}</small>}
                {p.ready && <span className="tv-lobby__ready">Ready</span>}
              </li>
            ))}
          </ul>
        )}
        <footer>{pub.lobbyLocked ? 'The room is locked. ' : ''}The show starts once everyone has tapped ready on their phone.</footer>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- between rounds

function RoundIntro({ pub }: { pub: PublicView }) {
  const round = pub.round!;
  const intro = useFit<HTMLDivElement>();
  // The categories arrive one after another when the card first comes up; one swapped in later comes at once.
  const titles = round.mode === 'trivia' ? round.board.map((cat) => cat.title).join('\n') : round.mode === 'final' ? round.category : '';
  const first = useRef(titles);
  const swapped = first.current !== titles;
  return (
    <div ref={intro} className="tv-intro">
      <span className="bz-eyebrow">
        Round {pub.roundIndex + 1} of {pub.rounds.length}
      </span>
      <h1>{round.title}</h1>
      <p>{roundBlurb(round)}</p>
      {round.mode === 'trivia' && (
        <ul className="tv-intro__cats">
          {round.board.map((cat, i) => (
            // Keyed by its title, so a category the host swaps for another flips in the way the first ones did.
            <li key={cat.title} style={{ animationDelay: `${swapped ? 0 : 500 + i * 160}ms` }}>
              {cat.title}
            </li>
          ))}
        </ul>
      )}
      {round.mode === 'final' && (
        <div key={round.category} className="tv-intro__cats tv-intro__cats--one" style={swapped ? { animationDelay: '0ms' } : undefined}>
          {round.category}
        </div>
      )}
    </div>
  );
}

function Standings({ pub }: SceneProps) {
  const table = placings(pub.players, pub.champions);
  const top = Math.max(1, ...table.map(({ player }) => Math.abs(player.score)));
  const next = pub.rounds[pub.roundIndex + 1];
  return (
    <div className="tv-standings">
      <ol style={columnsFor(table.length, 8)}>
        {table.map(({ player: p, place }, i) => (
          <li key={p.id} data-lead={place === 1 || undefined} data-out={p.eliminated || undefined} style={{ animationDelay: `${(table.length - i) * 110}ms` }}>
            <span className="tv-standings__rank bz-num">{place}</span>
            <Avatar avatar={p.avatar} size="2.6em" dim={p.eliminated} />
            <strong>{p.name}</strong>
            {pub.eliminatedNow.includes(p.id) && <span className="bz-pill bz-pill--bad">Eliminated</span>}
            <i className="tv-standings__bar" style={{ transform: `scaleX(${Math.max(0.02, Math.abs(p.score) / top)})` }} data-negative={p.score < 0 || undefined} />
            <Score value={p.score} className="tv-standings__score" />
          </li>
        ))}
      </ol>
      {pub.teams && (
        <ul className="tv-standings__teams">
          {pub.teams.map((t) => (
            <li key={t.id}>
              <span>{t.name}</span>
              <Score value={t.score} />
            </li>
          ))}
        </ul>
      )}
      {next && (
        <p className="tv-standings__next">
          Up next: <strong>{next.title}</strong>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the finish

interface Award {
  title: string;
  player: PublicPlayer;
  detail: string;
}

/** Bragging rights, each drawn from the server's own records of the game. */
function awards(pub: PublicView): Award[] {
  const stats = pub.stats ?? {};
  const best = (score: (s: PlayerStats) => number | null, higher: boolean) => {
    let winner: { p: PublicPlayer; v: number } | null = null;
    for (const p of pub.players) {
      const v = stats[p.id] ? score(stats[p.id]) : null;
      if (v === null) continue;
      if (!winner || (higher ? v > winner.v : v < winner.v)) winner = { p, v };
    }
    return winner;
  };
  const out: Award[] = [];
  const fastest = best((s) => s.fastestMs, false);
  if (fastest) out.push({ title: 'Fastest buzz', player: fastest.p, detail: fmtMs(fastest.v) });
  const sharpest = best((s) => (s.correct + s.incorrect >= 3 ? accuracy(s) : null), true);
  if (sharpest) out.push({ title: 'Sharpest shooter', player: sharpest.p, detail: `${fmtPercent(sharpest.v)} correct` });
  const busiest = best((s) => s.buzzWins || null, true);
  if (busiest) out.push({ title: 'First on the buzzer', player: busiest.p, detail: `${plural(busiest.v, 'clue')} won` });
  const surveyed = best((s) => s.surveyPoints || null, true);
  if (surveyed) out.push({ title: 'Survey says', player: surveyed.p, detail: `${surveyed.v} survey points` });
  return out;
}

function Finale({ pub }: SceneProps) {
  const champions = pub.players.filter((p) => pub.champions?.includes(p.id));
  const rest = placings(pub.players, pub.champions).filter(({ player }) => !champions.includes(player));
  const team = pub.teams?.find((t) => champions.length > 0 && champions.every((p) => p.teamId === t.id));

  return (
    <main className="tv-finale">
      <Logo />
      <span className="bz-eyebrow">{pub.name}</span>
      <h1>{champions.length === 0 ? 'That’s the show' : champions.length > 1 && !team ? 'It’s a tie!' : 'Champion'}</h1>
      {/* One champion has the stage alone. A tie or a winning team shares it, six to a row. */}
      <div className="tv-finale__champs" style={inRows(champions.length, rowsOf(champions.length, 6, 3))}>
        {champions.map((p) => (
          <div key={p.id} className="tv-finale__champ">
            <span className="tv-finale__crown" aria-hidden>
              👑
            </span>
            <Avatar avatar={p.avatar} size="9em" />
            <strong>{p.name}</strong>
            <Score value={p.score} />
          </div>
        ))}
      </div>
      {team && <p className="tv-finale__team">{team.name} take it</p>}
      <ol className="tv-finale__rest">
        {rest.slice(0, 7).map(({ player: p, place }) => (
          <li key={p.id}>
            <span className="bz-num">{ordinal(place)}</span>
            <Avatar avatar={p.avatar} size="2em" />
            <strong>{p.name}</strong>
            <Score value={p.score} />
          </li>
        ))}
      </ol>
      <ul className="tv-finale__awards">
        {awards(pub).map((a, i) => (
          <li key={a.title} style={{ animationDelay: `${1200 + i * 250}ms` }}>
            <span className="bz-eyebrow">{a.title}</span>
            <div>
              <Avatar avatar={a.player.avatar} size="2.2em" />
              <strong>{a.player.name}</strong>
            </div>
            <span className="bz-mono">{a.detail}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}

// ---------------------------------------------------------------- podiums

/** The row of contestants along the bottom of every in-game scene. */
function Podiums({ pub, players }: SceneProps) {
  const round = pub.round;
  const clue = round?.mode === 'trivia' ? round.clue : null;
  const answering = clue?.answererId ?? null;
  const control = round?.mode === 'trivia' && round.stage === 'board' ? round.controlId : null;
  const fmNow = round?.mode === 'fastMoney' && (round.stage === 'ready' || round.stage === 'answering') ? round.turns[round.turn] : [];
  const list = pub.players;
  const lastJudged = clue?.judgments.at(-1);

  return (
    // A dozen stand side by side; a bigger room goes onto a second row, and then a third.
    <footer className="tv-podiums" data-count={list.length > 8 ? 'many' : list.length > 5 ? 'some' : 'few'} style={inRows(list.length, rowsOf(list.length, 12, 3))}>
      {list.map((p) => {
        const out = p.eliminated || (clue?.excluded.includes(p.id) && clue.stage !== 'result');
        const flash = clue?.stage === 'result' || clue?.stage === 'open' ? lastJudged && lastJudged.playerId === p.id && lastJudged : null;
        return (
          <div
            key={p.id}
            className={cx('tv-podium', answering === p.id && 'is-answering', (control === p.id || fmNow.includes(p.id)) && 'is-control')}
            data-out={out || undefined}
            data-offline={!p.connected || undefined}
            data-flash={flash ? (flash.correct ? 'good' : 'bad') : undefined}
          >
            <Avatar avatar={p.avatar} size="2.5em" dim={!!out || !p.connected} />
            <div className="tv-podium__text">
              <strong>{players[p.id]?.name}</strong>
              <Score value={p.score} />
            </div>
            {control === p.id && <span className="tv-podium__tag">Picking</span>}
          </div>
        );
      })}
    </footer>
  );
}
