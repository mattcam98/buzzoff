/**
 * The phone controller. The screen follows the game: a buzzer during trivia,
 * a wager slider when one is asked for, a text box in Fast Money. Spectators
 * get the same screens without the controls.
 *
 * No screen scrolls as a page; only long lists do, inside a `data-scroll` region.
 */
import {
  accuracy, averageBuzzMs,
  type FastMoneyPublic, type FinalPublic, type PlayerView, type PublicPlayer, type PublicView, type TriviaPublic,
} from '@buzzoff/shared';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Redirect, useLocation } from 'wouter';
import type { Connection, Snapshot } from '../lib/connection';
import { useConnection } from '../lib/connection';
import { byScore, fmtDelta, fmtGap, fmtMs, fmtPercent, fmtScore, ordinal, playerMap } from '../lib/format';
import { useGameEvents, useWakeLock } from '../lib/hooks';
import { useFixedViewport } from '../lib/viewport';
import { haptic, play, unlockAudio } from '../lib/sound';
import { storage } from '../lib/storage';
import { BuzzLadder, Die, MediaView, rollLeaders, roundBlurb, Score, Seconds, textScale } from '../ui/game';
import { Avatar, Button, Modal, Notice, TimerBar, toast } from '../ui/kit';
import { IdentityFields } from './Home';
import '../styles/game.css';
import '../styles/home.css';
import '../styles/play.css';

interface Ctx {
  conn: Connection;
  snap: Snapshot;
  pub: PublicView;
  you: PlayerView | null;
  me: PublicPlayer | null;
  players: Record<string, PublicPlayer>;
}

/** Send an action and surface a rejection as a toast. Returns whether it was accepted. */
async function send(conn: Connection, action: Parameters<Connection['act']>[0]): Promise<boolean> {
  const ack = await conn.act(action);
  if (!ack.ok) toast(ack.error.message, 'error');
  return ack.ok;
}

export function Play({ code, spectator = false }: { code: string; spectator?: boolean }) {
  const seat = useMemo(() => (spectator ? null : storage.seat(code)), [code, spectator]);
  if (!spectator && !seat) return <Redirect to={`/join/${code}`} />;
  return <Session code={code} token={seat?.token ?? null} playerId={seat?.playerId ?? null} />;
}

function Session({ code, token, playerId }: { code: string; token: string | null; playerId: string | null }) {
  const [, navigate] = useLocation();
  const { conn, snap } = useConnection(playerId ? 'player' : 'spectator', code, token);
  useWakeLock();
  useFixedViewport();

  // Only this player's own moments make noise; the big screen carries the show.
  useGameEvents(conn, (e) => {
    if (!playerId) return;
    if (e.type === 'buzz.winner' && e.playerId === playerId) {
      haptic([40, 40, 90]);
      play('buzz');
    } else if (e.type === 'judged' && e.playerId === playerId) {
      haptic(e.correct ? [30, 40, 30] : 220);
      play(e.correct ? 'correct' : 'wrong');
    } else if (e.type === 'fm.duplicate' && e.playerId === playerId) {
      haptic([80, 40, 80]);
    } else if (e.type === 'dice.rolled' && e.playerId === playerId) {
      haptic([20, 50, 20, 50, 30]);
      play('dice');
    } else if (e.type === 'dice.won' && e.playerId === playerId) {
      haptic([30, 40, 30, 40, 120]);
      play('correct');
    }
  });

  if (snap.status === 'rejected') {
    if (snap.reason === 'unauthorized' && playerId) {
      // The seat is no longer ours (kicked, or taken over on another device).
      storage.setSeat(code, null);
      return <Redirect to={`/join/${code}`} />;
    }
    return (
      <Notice title="That game is gone">
        <p>
          There is no live game with the code <strong>{code}</strong>.
        </p>
        <Button variant="primary" onClick={() => navigate('/')}>
          Join another game
        </Button>
      </Notice>
    );
  }
  if (snap.status === 'ended') {
    const title = snap.reason === 'kicked' ? 'The host removed you' : snap.reason === 'replaced' ? 'Opened somewhere else' : 'This game has ended';
    return (
      <Notice title={title}>
        {snap.reason === 'replaced' && <p>Your seat is now open in another tab or on another device.</p>}
        <Button variant="primary" onClick={() => (snap.reason === 'replaced' ? window.location.reload() : navigate('/'))}>
          {snap.reason === 'replaced' ? 'Play here instead' : 'Back to start'}
        </Button>
      </Notice>
    );
  }
  const { pub } = snap;
  if (!pub || (playerId && !snap.you)) return <Notice title="Joining…" busy />;

  const players = playerMap(pub);
  const ctx: Ctx = { conn, snap, pub, you: snap.you, me: playerId ? (players[playerId] ?? null) : null, players };

  return (
    // Lifting a finger counts as a gesture that may start audio; touching down does not.
    <div className="bz-stage bz-app play" data-phase={pub.phase} onPointerUp={unlockAudio}>
      {snap.status !== 'online' && <div className="bz-banner">Reconnecting… your seat is safe</div>}
      <Header {...ctx} />
      <main className="play__main">
        {pub.paused ? (
          <Panel eyebrow="Stand by" title="Paused">
            <p>The host has paused the game.</p>
          </Panel>
        ) : (
          <Body {...ctx} />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- chrome

function Header({ pub, me, snap }: Ctx) {
  const net = me ? snap.net[me.id] : null;
  const rank = me ? byScore(pub.players).findIndex((p) => p.id === me.id) + 1 : 0;
  if (!me) {
    return (
      <header className="play__head">
        <div className="play__id">
          <span className="bz-eyebrow">Watching</span>
          <strong>{pub.name}</strong>
        </div>
        <span className="bz-pill">{pub.code}</span>
      </header>
    );
  }
  return (
    <header className="play__head">
      <Avatar avatar={me.avatar} size="var(--head-avatar)" dim={me.eliminated} />
      <div className="play__id">
        <strong>{me.name}</strong>
        <span>
          {me.eliminated ? 'Eliminated' : pub.phase === 'lobby' ? pub.code : `${ordinal(rank)} of ${pub.players.length}`}
          {pub.teams && me.teamId !== null && ` · ${pub.teams[me.teamId]?.name}`}
        </span>
      </div>
      <div className="play__score">
        <Score value={me.score} />
        {/* Connection latency, kept visibly separate from any buzz time. */}
        <span className="play__net bz-mono" data-quality={!net ? 'none' : net.rttMs < 80 ? 'good' : net.rttMs < 200 ? 'ok' : 'poor'} title="Round trip between this phone and the server">
          <i aria-hidden /> {net ? `${net.rttMs} ms ping` : 'measuring…'}
        </span>
      </div>
    </header>
  );
}

function Panel({ eyebrow, title, children, tone }: { eyebrow?: string; title?: ReactNode; children?: ReactNode; tone?: 'good' | 'bad' | 'buzz' }) {
  return (
    <section className="play__panel bz-rise" data-tone={tone}>
      {eyebrow && <span className="bz-eyebrow">{eyebrow}</span>}
      {title && <h1>{title}</h1>}
      {children}
    </section>
  );
}

/**
 * The scoreboard. It takes whatever height is left on the screen and scrolls
 * inside itself if there are more players than fit; the player's own row stays
 * pinned in view either way.
 */
function MiniBoard({ pub, me }: { pub: PublicView; me: PublicPlayer | null }) {
  const ranked = byScore(pub.players);
  return (
    <ol className="play__board" data-scroll data-many={ranked.length > 6 || undefined} aria-label="Scores">
      {ranked.map((p, i) => (
        <li key={p.id} data-me={p.id === me?.id || undefined} data-out={p.eliminated || undefined}>
          <span className="bz-num">{i + 1}</span>
          <Avatar avatar={p.avatar} size={26} dim={!p.connected || p.eliminated} />
          <strong>{p.name}</strong>
          <span className="bz-num">{fmtScore(p.score)}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- routing by phase

function Body(ctx: Ctx) {
  const { pub, me } = ctx;
  const round = pub.round;
  if (pub.phase === 'lobby') return <LobbyPanel {...ctx} />;
  if (pub.phase === 'finished') return <FinishedPanel {...ctx} />;
  if (pub.phase === 'standings') {
    return (
      <Panel eyebrow={`After round ${pub.roundIndex + 1}`} title={me && pub.eliminatedNow.includes(me.id) ? 'You’re out' : 'Standings'}>
        <MiniBoard pub={pub} me={me} />
      </Panel>
    );
  }
  if (!round) return null;
  if (round.stage === 'intro') {
    return (
      <Panel eyebrow={`Round ${pub.roundIndex + 1} of ${pub.rounds.length}`} title={round.title}>
        <p>{roundBlurb(round)}</p>
        <p className="play__hint">Eyes on the big screen.</p>
      </Panel>
    );
  }
  if (round.mode === 'trivia') return <TriviaPanel {...ctx} round={round} />;
  if (round.mode === 'fastMoney') return <FastMoneyPanel {...ctx} round={round} />;
  return <FinalPanel {...ctx} round={round} />;
}

// ---------------------------------------------------------------- lobby

function LobbyPanel({ conn, pub, me }: Ctx) {
  const [editing, setEditing] = useState(false);
  if (!me) {
    return (
      <Panel eyebrow="Lobby" title="Waiting to start">
        <MiniBoard pub={pub} me={null} />
      </Panel>
    );
  }
  return (
    <>
      <Panel eyebrow={pub.name} title="You’re in!" tone={me.ready ? 'good' : undefined}>
        <p className="play__extra">Check the big screen for your name. The host starts the show.</p>
        <Button variant={me.ready ? 'good' : 'primary'} size="l" block onClick={() => send(conn, { t: 'ready', ready: !me.ready })}>
          {me.ready ? '✓ Ready' : 'I’m ready'}
        </Button>
        {pub.teams && (
          <div className="play__teams" role="radiogroup" aria-label="Team">
            {pub.teams.map((t) => (
              <button key={t.id} role="radio" aria-checked={me.teamId === t.id} onClick={() => send(conn, { t: 'team', teamId: t.id })}>
                <strong>{t.name}</strong>
                <span>{t.playerIds.length} on the team</span>
              </button>
            ))}
          </div>
        )}
        <Button variant="ghost" onClick={() => setEditing(true)}>
          Change name or avatar
        </Button>
      </Panel>
      <p className="play__hint play__extra">
        {pub.players.length} in the room · keep this page open and your screen on
      </p>
      {editing && <ProfileEditor conn={conn} me={me} onClose={() => setEditing(false)} />}
    </>
  );
}

function ProfileEditor({ conn, me, onClose }: { conn: Connection; me: PublicPlayer; onClose: () => void }) {
  const [name, setName] = useState(me.name);
  const [avatar, setAvatar] = useState(me.avatar);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await send(conn, { t: 'profile', name, avatar })) {
      storage.setProfile({ name: name.trim(), avatar });
      onClose();
    }
  };
  return (
    <Modal title="Your look" onClose={onClose}>
      <form className="home__who" onSubmit={save}>
        <IdentityFields name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
        <Button type="submit" variant="primary" block disabled={!name.trim()}>
          Save
        </Button>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- trivia

function TriviaPanel(ctx: Ctx & { round: TriviaPublic }) {
  const { conn, pub, snap, you, me, players, round } = ctx;
  const clue = round.clue;

  if (round.stage === 'roll' && round.roll) return <RollPanel {...ctx} roll={round.roll} />;
  if (!clue) {
    // Everyone sees the board, nobody can press it: the player whose pick it is says it out loud and the host selects it.
    const picker = round.controlId ? players[round.controlId] : null;
    const mine = !!me && picker?.id === me.id;
    return (
      <section className="play__panel play__pick bz-rise" data-tone={mine ? 'buzz' : undefined}>
        <h1>
          {mine ? (
            <>
              <span className="bz-eyebrow">Your pick</span> Tell the host
            </>
          ) : picker ? (
            `${picker.name} is picking`
          ) : (
            'Next clue coming up'
          )}
        </h1>
        <div
          className="play__grid"
          role="group"
          aria-label={mine ? 'The board. Say the category and the points you want; the host will select it.' : 'The board'}
          style={{ gridTemplateColumns: `repeat(${round.board.length}, minmax(0, 1fr))`, '--rows': Math.max(...round.board.map((c) => c.clues.length)) } as CSSProperties}
        >
          {round.board.map((cat, c) => (
            <div key={c} className="play__col">
              <span>{cat.title}</span>
              {cat.clues.map((cl, k) => (
                <b key={k} className="bz-num" data-used={cl.used || undefined} aria-label={cl.used ? `${cat.title}, ${cl.value}: played` : `${cat.title} for ${cl.value}`}>
                  {cl.value}
                </b>
              ))}
            </div>
          ))}
        </div>
      </section>
    );
  }

  const answerer = clue.answererId ? players[clue.answererId] : null;
  const wagerer = clue.wager ? players[clue.wager.playerId] : null;
  const mine = me ? clue.judgments.filter((j) => j.playerId === me.id).at(-1) : undefined;

  if (clue.stage === 'wager') {
    if (you?.wager) return <WagerPanel conn={conn} wager={you.wager} title="Wager!" hint={`A hidden wager in ${clue.category}. You answer alone — how much will you risk?`} />;
    return (
      <Panel eyebrow={clue.category} title="Wager!" tone="buzz">
        <p>{wagerer?.name ?? 'Someone'} found a hidden wager and is deciding how much to risk.</p>
      </Panel>
    );
  }

  const adjusted = pub.buzzer.arbitration === 'latencyAdjusted';
  const gotIt = clue.judgments.find((j) => j.correct);
  return (
    <div className="play__stage" data-stage={clue.stage}>
      <section className="play__clue">
        <header>
          <span>{clue.category}</span>
          <b className="bz-num">{clue.isWager ? `Wager ${fmtScore(clue.wager?.amount ?? 0)}` : fmtScore(clue.value)}</b>
        </header>
        {clue.media?.kind === 'image' && <MediaView media={clue.media} className="play__media" />}
        {clue.media && clue.media.kind !== 'image' && <span className="bz-pill bz-pill--cyan">{clue.media.kind === 'audio' ? '🎧 Listen' : '🎬 Watch'} on the big screen</span>}
        {clue.question === null ? (
          // Nobody reads on while an answer is judged; the question comes back if the buzzers reopen.
          <p className="play__hidden">Question hidden while {answerer?.id === me?.id ? 'you answer' : `${answerer?.name ?? 'someone'} answers`}</p>
        ) : (
          // Long clues shrink first and only then scroll, inside the card.
          <p data-scroll data-scale={textScale(clue.question)}>
            {clue.question}
          </p>
        )}
        <TimerBar timer={clue.timer} held={clue.held} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />
      </section>

      <div className="play__center">
        {clue.stage === 'result' ? (
          <Panel eyebrow={clue.timedOut ? 'Time’s up' : 'Answer'} title={clue.answer} tone={mine ? (mine.correct ? 'good' : 'bad') : undefined}>
            {mine ? <p className="play__delta bz-num">{fmtDelta(mine.delta)}</p> : <p>{gotIt ? `${players[gotIt.playerId]?.name ?? 'Someone'} got it.` : 'Nobody got it.'}</p>}
          </Panel>
        ) : clue.isWager ? (
          <Panel eyebrow="Wager clue" title={answerer?.id === me?.id ? 'Answer out loud' : `${answerer?.name ?? 'Someone'} is answering`} tone={answerer?.id === me?.id ? 'buzz' : undefined} />
        ) : you ? (
          <Buzzer {...ctx} you={you} round={round} />
        ) : (
          <Panel title={answerer ? `${answerer.name} buzzed first` : clue.stage === 'open' ? 'Buzzers are open' : 'Buzzers locked'} />
        )}
      </div>

      {clue.stage === 'answering' && clue.attempts.length > 0 && (
        <div className="play__timing">
          <BuzzLadder attempts={clue.attempts} players={players} adjusted={adjusted} limit={3} />
          <p>{adjusted ? 'Server-recorded, minus half of each player’s ping. Not reaction times.' : 'Server-recorded times. They include network delay, so they are not reaction times.'}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The roll for the first pick. Tapping only asks the server to roll; the number is the
 * server's, and the die on screen tumbles onto it when it arrives.
 */
function RollPanel({ conn, pub, snap, me, players, roll }: Ctx & { roll: NonNullable<TriviaPublic['roll']> }) {
  const [pressed, setPressed] = useState(false);
  useEffect(() => setPressed(false), [roll.round]);

  const inIt = !!me && roll.contenders.includes(me.id);
  const mine = me ? (roll.rolls[me.id] ?? roll.out[me.id] ?? null) : null;
  const canRoll = inIt && roll.phase === 'rolling' && mine === null;
  const tied = roll.phase === 'tied' ? rollLeaders(roll) : [];
  const winner = roll.winnerId ? players[roll.winnerId] : null;
  const waitingFor = roll.contenders.filter((id) => roll.rolls[id] === undefined).length;

  const tap = async () => {
    if (!canRoll || pressed) return;
    setPressed(true);
    haptic(25);
    if (!(await send(conn, { t: 'roll' }))) setPressed(false);
  };

  const [title, hint] = winner
    ? winner.id === me?.id
      ? ['You pick first!', 'Tell the host your category and points.']
      : [`${winner.name} picks first`, 'Eyes on the board.']
    : tied.length
      ? me && tied.includes(me.id)
        ? ['A tie — you roll again', 'Get ready.']
        : ['A tie!', `${tied.map((id) => players[id]?.name).filter(Boolean).join(' and ')} roll again.`]
      : canRoll
        ? ['Tap to roll', 'The highest roll picks the first clue.']
        : inIt
          ? [`You rolled a ${mine}`, waitingFor ? `Waiting for ${waitingFor} more…` : 'Here it comes…']
          : me && mine !== null
            ? [`You rolled a ${mine}`, 'Not enough this time. Watch the tie-break.']
            : ['Rolling for the first pick', 'The highest roll picks the first clue.'];

  return (
    <section className="play__panel play__roll bz-rise" data-tone={winner?.id === me?.id && winner ? 'good' : canRoll ? 'buzz' : undefined}>
      <span className="bz-eyebrow">{roll.round === 1 ? 'Who picks first?' : `Tie-break ${roll.round - 1}`}</span>
      <h1 aria-live="polite">{title}</h1>
      {me && (
        <button
          className="play__dice"
          data-ready={canRoll && !pressed ? true : undefined}
          disabled={!canRoll || pressed}
          // Like the buzzer, this answers the touch itself rather than the finger lifting.
          onPointerDown={(e) => {
            e.preventDefault();
            void tap();
          }}
          aria-label={canRoll ? 'Roll the die' : `Your die: ${mine ?? 'not rolled'}`}
        >
          <Die value={mine} />
        </button>
      )}
      <p className="play__hint">
        {hint} {canRoll && <Seconds pub={pub} snap={snap} />}
      </p>
      <ul className="play__rolls" data-scroll aria-label="Everyone’s rolls">
        {pub.players
          .filter((p) => roll.contenders.includes(p.id) || roll.out[p.id] !== undefined)
          .map((p) => (
            <li key={p.id} data-out={!roll.contenders.includes(p.id) || undefined} data-winner={p.id === roll.winnerId || undefined} data-me={p.id === me?.id || undefined}>
              <Avatar avatar={p.avatar} size={22} dim={!roll.contenders.includes(p.id)} />
              <span>{p.name}</span>
              <Die value={roll.rolls[p.id] ?? roll.out[p.id] ?? null} />
            </li>
          ))}
      </ul>
    </section>
  );
}

function Buzzer({ conn, snap, pub, you, players, round }: Ctx & { you: PlayerView; round: TriviaPublic }) {
  const clue = round.clue!;
  const { state, ms, deltaMs } = you.buzzer;
  const [pressed, setPressed] = useState(false);
  const canPress = state === 'open';
  const answerer = clue.answererId ? players[clue.answererId] : null;

  // Whenever the server changes our buzzer state (a new clue, a steal, a reset), forget the last press.
  useEffect(() => setPressed(false), [state, clue.cat, clue.idx, clue.judgments.length]);

  const press = async () => {
    if (!canPress || pressed) return;
    setPressed(true);
    haptic(25);
    const ack = await conn.buzz();
    if (!ack.ok) {
      setPressed(false);
      toast(ack.error.message, 'error');
    }
  };

  // Space bar buzzes too, for anyone playing on a laptop.
  const pressRef = useRef(press);
  pressRef.current = press;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        void pressRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const visual = pressed && state === 'open' ? 'buzzed' : state;
  const label: Record<string, [string, string]> = {
    open: ['Buzz!', 'Tap now'],
    buzzed: ['Buzzed', ms !== null ? fmtMs(ms) : 'Sent…'],
    yours: ['You’re up!', 'Answer out loud'],
    taken: [answerer?.name ?? 'Taken', 'buzzed first'],
    out: ['Out', 'You’ve had your go'],
    hidden: ['', ''],
  };
  const [big, small] = label[visual] ?? ['', ''];

  return (
    <section className="play__buzz">
      <div className="play__buzzwrap">
        <button
          className="play__buzzer"
          data-state={visual}
          disabled={!canPress || pressed}
          // pointerdown fires on touch, a click only on release — tens of milliseconds later.
          onPointerDown={(e) => {
            e.preventDefault();
            void press();
          }}
          aria-label={state === 'open' ? 'Buzz' : `${big}. ${small}`}
        >
          <span>{big}</span>
          <small>{small}</small>
        </button>
      </div>
      <div className="play__readout" aria-live="polite">
        {ms !== null ? (
          <p>
            Your buzz registered at <b className="bz-mono">{fmtMs(ms)}</b>
            {deltaMs !== null && state !== 'yours' && deltaMs !== 0 && (
              <>
                {' '}
                · <b className="bz-mono">{fmtGap(deltaMs)}</b> {deltaMs > 0 ? 'behind' : 'ahead of'} the winner
              </>
            )}
            {state === 'yours' && ' · first in'}
          </p>
        ) : state === 'yours' || state === 'taken' ? null : (
          <p>{state === 'open' && <Seconds pub={pub} snap={snap} />}</p>
        )}
      </div>
    </section>
  );
}

function WagerPanel({ conn, wager, title, hint }: { conn: Connection; wager: NonNullable<PlayerView['wager']>; title: string; hint: string }) {
  const clamp = (n: number) => Math.max(wager.min, Math.min(wager.max, Math.round(n) || 0));
  // The field holds what was typed, so it can be cleared and retyped; the wager is that, kept within bounds.
  const [typed, setTyped] = useState(() => String(wager.amount ?? clamp(Math.round(wager.max / 2 / 100) * 100)));
  const [sending, setSending] = useState(false);
  const amount = clamp(Number(typed));
  const setAmount = (n: number) => setTyped(String(clamp(n)));
  const lockIn = async () => {
    setSending(true);
    await send(conn, { t: 'wager', amount });
    setSending(false);
  };
  // The +/− buttons and slider mean a wager can be set without ever opening the keyboard.
  const step = wager.max <= 1000 ? 50 : wager.max <= 5000 ? 100 : 500;
  if (wager.amount !== null) {
    return (
      <Panel eyebrow="Wager locked" title={fmtScore(wager.amount)} tone="good">
        <p>Good luck.</p>
      </Panel>
    );
  }
  return (
    <section className="play__panel play__wagerpanel bz-rise" data-tone="buzz">
      <span className="bz-eyebrow">{title}</span>
      <p className="play__extra">{hint}</p>
      <div className="play__amount">
        <button type="button" onClick={() => setAmount(amount - step)} disabled={amount <= wager.min} aria-label={`Wager ${step} less`}>
          −
        </button>
        <input className="play__wager bz-num" type="number" inputMode="numeric" min={wager.min} max={wager.max} value={typed} onChange={(e) => setTyped(e.target.value)} onBlur={() => setAmount(amount)} aria-label="Wager amount" />
        <button type="button" onClick={() => setAmount(amount + step)} disabled={amount >= wager.max} aria-label={`Wager ${step} more`}>
          +
        </button>
      </div>
      <input type="range" className="play__range play__nokb" min={wager.min} max={wager.max} step={Math.max(1, Math.round(wager.max / 100))} value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Wager slider" />
      <div className="play__chips play__nokb">
        <button type="button" onClick={() => setAmount(wager.min)}>{fmtScore(wager.min)}</button>
        <button type="button" onClick={() => setAmount(wager.max / 4)}>¼</button>
        <button type="button" onClick={() => setAmount(wager.max / 2)}>½</button>
        <button type="button" onClick={() => setAmount(wager.max)}>All in · {fmtScore(wager.max)}</button>
      </div>
      <Button variant="primary" size="l" block disabled={sending} onClick={lockIn}>
        Lock in {fmtScore(amount)}
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------- fast money

function FastMoneyPanel(ctx: Ctx & { round: FastMoneyPublic }) {
  const { pub, snap, you, me, players, round } = ctx;
  const mine = you?.fastMoney ?? null;
  const active = round.turns[round.turn] ?? [];
  const names = active.map((id) => players[id]?.name).filter(Boolean).join(' & ');

  if (mine?.active) return <FastMoneyInput {...ctx} mine={mine} />;

  if (round.stage === 'ready' || round.stage === 'answering') {
    if (mine?.when === 'now') {
      return mine.finished ? (
        <Panel eyebrow="Locked in" title="Answers sent" tone="good">
          <p>Watch the big screen for the reveal.</p>
        </Panel>
      ) : (
        <Panel eyebrow={round.title} title="You’re up next" tone="buzz">
          <p>
            {round.questions.length} survey questions. Type the most popular answer you can think of for each
            {round.blockDuplicates && round.turn > 0 ? ' — and no repeating answers already given' : ''}.
          </p>
          <p className="play__hint play__extra">The clock starts when the host says go.</p>
        </Panel>
      );
    }
    return (
      <>
        <Panel eyebrow={round.title} title={round.stage === 'answering' ? `${names || 'Contestants'} ${active.length > 1 ? 'are' : 'is'} answering` : `${names || 'Next contestant'} — get ready`}>
          {mine?.when === 'before' && <p>You’re after this. No peeking at their answers!</p>}
          <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />
        </Panel>
        {!mine && <MiniBoard pub={pub} me={me} />}
      </>
    );
  }

  const myCells = me ? round.cells[me.id] : undefined;
  const won = me ? round.outcome?.winners.includes(me.id) : false;
  return (
    <Panel
      eyebrow={round.title}
      title={round.stage === 'result' ? (mine ? (won ? 'You did it!' : 'Round over') : 'Final totals') : 'Survey says…'}
      tone={round.stage === 'result' && mine ? (won ? 'good' : undefined) : undefined}
    >
      <div className="play__lists" data-scroll>
        {myCells && (
          <ul className="play__cells">
            {myCells.map((cell, i) => (
              <li key={i} data-zero={cell.points === 0 || undefined}>
                <span>{cell.text === null ? `Question ${i + 1}` : cell.text || '—'}</span>
                <b className="bz-num">{cell.points ?? ''}</b>
              </li>
            ))}
          </ul>
        )}
        <ul className="play__totals">
          {round.turns.flat().map((id) => (
            <li key={id} data-me={id === me?.id || undefined} data-winner={round.outcome?.winners.includes(id) || undefined}>
              {players[id] && <Avatar avatar={players[id].avatar} size={26} />}
              <strong>{players[id]?.name ?? '—'}</strong>
              <b className="bz-num">{round.totals[id] ?? 0}</b>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

function FastMoneyInput({ conn, pub, snap, round, mine }: Ctx & { round: FastMoneyPublic; mine: NonNullable<PlayerView['fastMoney']> }) {
  const total = round.questions.length;
  // Answers we have sent but the server has not confirmed yet. The clock is
  // running, so the screen moves on at once and only comes back if one is rejected.
  const [sent, setSent] = useState<Record<number, string>>({});
  const answers = mine.answers.map((a, i) => sent[i] ?? a);
  const firstBlank = answers.findIndex((a) => !a);
  const [q, setQ] = useState(firstBlank < 0 ? 0 : firstBlank);
  const [text, setText] = useState(answers[q] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState(firstBlank < 0);
  const input = useRef<HTMLInputElement>(null);
  const live = useRef({ q, text });
  live.current = { q, text };

  const go = (index: number, value = answers[index] ?? '', problem: string | null = null) => {
    setQ(index);
    setText(value);
    setError(problem);
    setReview(false);
    requestAnimationFrame(() => input.current?.focus());
  };
  /** The next question still blank after `from`, wrapping round; -1 when all are answered. */
  const nextBlank = (from: number, list: string[]) => {
    for (let step = 1; step < total; step++) {
      const i = (from + step) % total;
      if (!list[i]) return i;
    }
    return -1;
  };
  const advance = (list: string[]) => {
    const next = nextBlank(q, list);
    if (next < 0) setReview(true);
    else go(next, '');
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    const index = q;
    if (!value) return advance(answers);
    setSent((s) => ({ ...s, [index]: value }));
    void conn.act({ t: 'fm.answer', q: index, text: value }).then((ack) => {
      setSent(({ [index]: _confirmed, ...rest }) => rest);
      if (ack.ok) return;
      haptic([80, 40, 80]);
      if (ack.error.code === 'duplicate') play('strike');
      // Go back to fix it, unless they are already part-way through typing another answer.
      if (live.current.q !== index && live.current.text.trim()) toast(`Question ${index + 1}: ${ack.error.message}`, 'error');
      else go(index, value, ack.error.message);
    });
    advance(answers.map((a, i) => (i === index ? value : a)));
  };

  if (review) {
    return (
      <section className="play__panel play__fm bz-rise">
        <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />
        <div className="play__fmhead">
          <span className="bz-eyebrow">Your answers · tap one to change it</span>
          <Seconds pub={pub} snap={snap} className="play__fmclock" />
        </div>
        <ul className="play__cells" data-scroll>
          {round.questions.map((question, i) => (
            <li key={i}>
              <button onClick={() => go(i)}>
                <small>{question}</small>
                <span>{answers[i] || '— tap to answer —'}</span>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="good" size="l" block disabled={Object.keys(sent).length > 0} onClick={() => send(conn, { t: 'fm.done' })}>
          Lock in my answers
        </Button>
      </section>
    );
  }

  // Built to sit above an open keyboard: progress and the clock share one row,
  // and the submit button sits beside the field instead of below it.
  return (
    <form className="play__panel play__fm" onSubmit={submit} key={q}>
      <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />
      <div className="play__fmhead">
        <div className="play__dots" role="tablist" aria-label={`Question ${q + 1} of ${total}`}>
          {round.questions.map((_, i) => (
            <button type="button" key={i} role="tab" aria-selected={i === q} data-done={!!answers[i] || undefined} onClick={() => go(i)} aria-label={`Question ${i + 1}`}>
              {i + 1}
            </button>
          ))}
        </div>
        <Seconds pub={pub} snap={snap} className="play__fmclock" />
      </div>
      <h1 className="play__fmq" data-scale={textScale(round.questions[q] ?? '')}>
        {round.questions[q]}
      </h1>
      <div className="play__entry">
        <input
          ref={input}
          className="bz-input play__fminput"
          data-error={error ? true : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          maxLength={80}
          placeholder="Type your answer"
          aria-label="Your answer"
          autoFocus
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="next"
        />
        <Button type="submit" variant="primary" disabled={!text.trim()}>
          Submit
        </Button>
      </div>
      <div className="play__fmfoot">
        {error ? (
          <p className="play__fmerror" role="alert">
            {error}
          </p>
        ) : (
          <span />
        )}
        <button type="button" className="play__pass" onClick={() => advance(answers)}>
          Pass
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- final

function FinalPanel({ conn, pub, snap, you, me, players, round }: Ctx & { round: FinalPublic }) {
  const [text, setText] = useState(you?.final?.answer ?? '');
  const [saved, setSaved] = useState(!!you?.final?.answer);
  const myReveal = me ? round.reveals.find((r) => r.playerId === me.id) : undefined;

  if (round.stage === 'wager') {
    if (you?.wager) return <WagerPanel conn={conn} wager={you.wager} title={round.title} hint={`The category is “${round.category}”. Everyone wagers before seeing the question.`} />;
    return (
      <Panel eyebrow={round.title} title={round.category}>
        <p>Everyone is placing a wager.</p>
        <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />
      </Panel>
    );
  }

  if (round.stage === 'answering' && you?.final?.canAnswer) {
    const save = async (e: FormEvent) => {
      e.preventDefault();
      if (await send(conn, { t: 'final.answer', text })) setSaved(true);
    };
    return (
      <form className="play__panel play__fm" onSubmit={save}>
        <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />
        <div className="play__fmhead">
          <span className="bz-eyebrow">{round.category}</span>
          <Seconds pub={pub} snap={snap} className="play__fmclock" />
        </div>
        <h1 className="play__fmq" data-scale={textScale(round.question ?? '')} data-scroll>
          {round.question}
        </h1>
        <div className="play__entry">
          <input
            className="bz-input play__fminput"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            maxLength={120}
            placeholder="Write your answer"
            aria-label="Your answer"
            autoFocus
            autoComplete="off"
            enterKeyHint="done"
          />
          <Button type="submit" variant={saved ? 'good' : 'primary'} disabled={!text.trim()}>
            {saved ? '✓ Saved' : 'Save answer'}
          </Button>
        </div>
        <div className="play__fmfoot">
          <p className="play__hint">{saved ? 'Saved. You can change it until time runs out.' : 'Save it before the clock runs out.'}</p>
        </div>
      </form>
    );
  }

  const current = round.reveals.at(-1);
  return (
    <div className="play__stage">
      <section className="play__clue">
        <header>
          <span>{round.category}</span>
          <b className="bz-num">{round.title}</b>
        </header>
        <p data-scroll data-scale={textScale(round.question ?? '')}>
          {round.question}
        </p>
      </section>
      <div className="play__center">
        {myReveal && myReveal.correct !== null ? (
          <Panel eyebrow="You wrote" title={myReveal.answer || 'Nothing'} tone={myReveal.correct ? 'good' : 'bad'}>
            <p className="play__delta bz-num">{fmtDelta(myReveal.delta ?? 0)}</p>
            {round.answer && <p>Answer: {round.answer}</p>}
          </Panel>
        ) : (
          <Panel eyebrow={round.answer ? 'Answer' : 'The reveal'} title={round.answer ?? (current ? `${players[current.playerId]?.name ?? 'Someone'} wrote “${current.answer || 'nothing'}”` : 'Pens down')}>
            {you?.final?.answer && !round.answer && <p>Your answer: {you.final.answer}</p>}
          </Panel>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the end

function FinishedPanel({ pub, me }: Ctx) {
  const champion = me ? pub.champions?.includes(me.id) : false;
  const rank = me ? byScore(pub.players).findIndex((p) => p.id === me.id) + 1 : 0;
  const stats = me ? pub.stats?.[me.id] : undefined;
  const avg = stats ? averageBuzzMs(stats) : null;
  const names = pub.players.filter((p) => pub.champions?.includes(p.id)).map((p) => p.name);
  return (
    <>
      <Panel eyebrow={pub.name} title={champion ? '👑 You won!' : me ? `You finished ${ordinal(rank)}` : `${names.join(' & ') || 'Nobody'} won`} tone={champion ? 'buzz' : undefined}>
        {!champion && me && names.length > 0 && <p className="play__roomy">{names.join(' & ')} took the crown.</p>}
        {stats && (
          <dl className="play__stats">
            <div>
              <dt>Clues won</dt>
              <dd className="bz-num">{stats.buzzWins}</dd>
            </div>
            <div>
              <dt>Correct</dt>
              <dd className="bz-num">{fmtPercent(accuracy(stats))}</dd>
            </div>
            <div>
              <dt>Fastest registered buzz</dt>
              <dd className="bz-mono">{stats.fastestMs === null ? '—' : fmtMs(stats.fastestMs)}</dd>
            </div>
            <div>
              <dt>Average registered buzz</dt>
              <dd className="bz-mono">{avg === null ? '—' : fmtMs(avg)}</dd>
            </div>
          </dl>
        )}
      </Panel>
      <MiniBoard pub={pub} me={me} />
      <p className="play__hint play__extra">Stay on this page — if the host starts another game you’re already in.</p>
    </>
  );
}
