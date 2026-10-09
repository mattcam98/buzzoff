/**
 * The host's live console: everything needed to run a show from one screen,
 * with the next sensible action always on the space bar.
 */
import { canStart, CUE_NAMES, notReady, type CueName, type HostAction, type HostRoomView, type PublicPlayer, type PublicView } from '@buzzoff/shared';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { api, ApiFailure } from '../../lib/api';
import { useConnection, type Snapshot } from '../../lib/connection';
import { byScore, fmtScore, joinAddress, placings, playerMap, plural } from '../../lib/format';
import { useHotkeys } from '../../lib/hooks';
import { storage } from '../../lib/storage';
import { roundBlurb, Score } from '../../ui/game';
import { Avatar, Button, cx, Logo, Modal, Notice, toast } from '../../ui/kit';
import { FastMoneyStage, FinalStage, TriviaStage } from './console/Stages';
import { usePeek } from './console/peek';
import '../../styles/game.css';
import '../../styles/console.css';

export interface StageProps {
  pub: PublicView;
  host: HostRoomView;
  snap: Snapshot;
  players: Record<string, PublicPlayer>;
  run: (action: HostAction) => Promise<boolean>;
}

const CUES: Record<CueName, [string, string]> = {
  applause: ['👏', 'Applause'],
  drumroll: ['🥁', 'Drum roll'],
  airhorn: ['📣', 'Air horn'],
  sad: ['🎺', 'Sad trombone'],
  tada: ['✨', 'Ta-da'],
  suspense: ['😬', 'Suspense'],
  confetti: ['🎉', 'Confetti'],
};

const SHORTCUTS: [string, string][] = [
  ['Space', 'Do the highlighted next step'],
  ['C', 'Rule the answer correct'],
  ['X', 'Rule the answer incorrect'],
  ['R', 'Reveal the answer (nobody gets it)'],
  ['U', 'Undo the last ruling or step'],
  ['P', 'Pause or resume'],
  ['?', 'Show this list'],
];

/** Clicked with the mouse, a switch lets go of the keyboard, so Space is still "next step" and not a second flip. */
const letGo = (input: HTMLInputElement) => {
  if (!input.matches(':focus-visible')) input.blur();
};

/** Symbols that stand in for a button's words in the top bar on a phone. */
const ICONS = {
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  pause: 'M8 5v14M16 5v14',
  resume: 'M7 4.5v15l12-7.5z',
};
function TopLabel({ icon, children }: { icon: keyof typeof ICONS; children: ReactNode }) {
  return (
    <>
      <svg className="hc-top__icon" viewBox="0 0 24 24" aria-hidden>
        <path d={ICONS[icon]} />
      </svg>
      <span className="hc-top__label">{children}</span>
    </>
  );
}

export function HostConsole({ code }: { code: string }) {
  const hostKey = useMemo(() => storage.hostKey(code), [code]);
  if (!hostKey) {
    return (
      <Notice title="This isn’t your game">
        <p>
          This browser does not hold the host key for <strong>{code}</strong>. Open the console on the device that created the game.
        </p>
        <Link className="bz-btn bz-btn--primary" href="/host">
          Host dashboard
        </Link>
      </Notice>
    );
  }
  return <Console code={code} hostKey={hostKey} />;
}

function Console({ code, hostKey }: { code: string; hostKey: string }) {
  const { conn, snap } = useConnection('host', code, hostKey);
  const [help, setHelp] = useState(false);
  const [managing, setManaging] = useState<string | null>(null);

  const run = async (action: HostAction) => {
    const ack = await conn.host(action);
    if (!ack.ok) toast(ack.error.message, 'error');
    return ack.ok;
  };

  // A shortcut clicks the on-screen button that carries it, so it can never do
  // something the visible controls would not.
  useHotkeys((key, e) => {
    if (key === '?') return setHelp(true);
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Enter on a focused button or link presses that control, as it does everywhere else.
    if (key === 'Enter' && focused?.closest('button, a, summary')) return;
    const name = key === ' ' || key === 'Enter' ? 'space' : key;
    const target = document.querySelector<HTMLButtonElement>(`.hc [data-hotkey="${CSS.escape(name)}"]:not(:disabled)`);
    if (target) {
      e.preventDefault();
      // The space bar always means "next step", even right after clicking some other button:
      // letting go of that button's focus keeps the same key press from also pressing it.
      if (focused !== target) focused?.blur();
      target.click();
    } else if (key === ' ') {
      // With no step to take, Space does nothing at all. Left to the browser it would scroll the page, or
      // press whichever button the mouse clicked last a second time: another nudge to a score, another undo.
      e.preventDefault();
      focused?.closest('button')?.blur();
    }
  }, !help && !managing);

  if (snap.status === 'rejected') {
    return (
      <Notice title={snap.reason === 'no_room' ? 'That game has ended' : 'Host key not accepted'}>
        <p>Games are cleared out after they have sat idle for a while.</p>
        <Link className="bz-btn bz-btn--primary" href="/host">
          Host dashboard
        </Link>
      </Notice>
    );
  }
  if (snap.status === 'ended') return <Notice title="This game was closed" />;
  const { pub, host } = snap;
  if (!pub || !host) return <Notice title="Opening the console…" busy />;

  const players = playerMap(pub);
  const props: StageProps = { pub, host, snap, players, run };

  return (
    <div className="bz-stage hc">
      <div className="hc-bar">
        <header className="hc-top">
          <Logo to="/host" />
          <div className="hc-top__game">
            <strong>{pub.name}</strong>
            <span>
              <span className="hc-top__wide">Room </span>
              <b>{pub.code}</b> · {plural(host.audience.displays, 'screen')}
              {host.audience.spectators > 0 && ` · ${plural(host.audience.spectators, 'spectator')}`}
            </span>
          </div>
          <nav className="hc-top__actions" aria-label="Game controls">
            <a className="bz-btn bz-btn--s bz-btn--ghost" href={`/tv/${pub.code}`} target="_blank" rel="noreferrer">
              <span>
                <span className="hc-top__wide">Open </span>TV ↗
              </span>
            </a>
            <Button size="s" variant="ghost" hotkey="U" disabled={!host.undo} onClick={() => run({ t: 'undo' })} title={host.undo ? `Undo: ${host.undo}` : 'Nothing to undo'}>
              <TopLabel icon="undo">
                Undo{host.undo && <span className="hc-top__undo"> {host.undo}</span>}
              </TopLabel>
            </Button>
            {pub.phase !== 'finished' && pub.phase !== 'lobby' && (
              <Button size="s" variant={pub.paused ? 'primary' : 'ghost'} hotkey="P" onClick={() => run({ t: 'pause', paused: !pub.paused })}>
                <TopLabel icon={pub.paused ? 'resume' : 'pause'}>{pub.paused ? 'Resume' : 'Pause'}</TopLabel>
              </Button>
            )}
            <Button size="s" variant="ghost" icon className="hc-top__keys" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">
              ?
            </Button>
          </nav>
        </header>
        {/* Under the controls rather than above them, so it is never behind the status bar and never scrolls away. */}
        {snap.status !== 'online' && <div className="bz-banner">Connection lost — reconnecting. The game is safe on the server.</div>}
      </div>

      <div className="hc-body">
        <main className="hc-main">
          {pub.paused && (
            <div className="hc-paused">
              <strong>Paused.</strong> Timers are frozen and buzzers are shut until you resume. Scores can still be corrected.
              <Button size="s" variant="primary" onClick={() => run({ t: 'pause', paused: false })}>
                Resume
              </Button>
            </div>
          )}
          <Rundown pub={pub} />
          <Stage {...props} />
        </main>

        <aside className="hc-side">
          {host.claims.map((claim) => (
            <section key={claim.id} className="hc-card hc-claim">
              <p>
                Someone is asking to rejoin as <strong>{claim.name}</strong>, who is disconnected. Let them take over that seat and score?
              </p>
              <div>
                <Button size="s" variant="good" onClick={() => run({ t: 'claim.resolve', claimId: claim.id, approve: true })}>
                  Let them in
                </Button>
                <Button size="s" variant="ghost" onClick={() => run({ t: 'claim.resolve', claimId: claim.id, approve: false })}>
                  Deny
                </Button>
              </div>
            </section>
          ))}
          <Roster {...props} onManage={setManaging} />
          <section className="hc-card">
            <h2 className="bz-eyebrow">Sound &amp; effects on the TV</h2>
            <label className="bz-toggle" title="The theme between rounds, a quiet pulse while a question is live, and silence while someone answers.">
              <input
                type="checkbox"
                checked={pub.music}
                onChange={(e) => {
                  void run({ t: 'music', on: e.target.checked });
                  letGo(e.target);
                }}
              />
              Background music
            </label>
            <div className="hc-cues">
              {CUE_NAMES.map((name) => (
                <button key={name} onClick={() => run({ t: 'cue', name })} title={CUES[name][1]} aria-label={CUES[name][1]}>
                  <span aria-hidden>{CUES[name][0]}</span>
                  {CUES[name][1]}
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {managing && players[managing] && <ManagePlayer {...props} player={players[managing]} onClose={() => setManaging(null)} />}
      {help && (
        <Modal title="Keyboard shortcuts" onClose={() => setHelp(false)}>
          <dl className="hc-keys">
            {SHORTCUTS.map(([key, what]) => (
              <div key={key}>
                <dt>
                  <kbd className="bz-kbd">{key}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <p className="hc-note">Shortcuts only ever press a button you can see. They are off while you type in a field.</p>
        </Modal>
      )}
    </div>
  );
}

/** Where we are in the running order. */
function Rundown({ pub }: { pub: PublicView }) {
  const at = pub.phase === 'lobby' ? -1 : pub.phase === 'finished' ? pub.rounds.length : pub.roundIndex;
  const list = useRef<HTMLOListElement>(null);
  // On a phone the list is one line that scrolls sideways: keep the current step in view as the show moves on.
  useEffect(() => {
    const row = list.current;
    const now = row?.querySelector<HTMLElement>('[data-state="now"]');
    if (row && now) row.scrollTo({ left: now.offsetLeft - (row.clientWidth - now.offsetWidth) / 2 });
  }, [at]);
  return (
    <ol ref={list} className="hc-rundown" aria-label="Running order">
      <li data-state={at === -1 ? 'now' : 'done'}>Lobby</li>
      {pub.rounds.map((r, i) => (
        <li key={i} data-state={i === at ? 'now' : i < at ? 'done' : 'next'}>
          {r.title}
        </li>
      ))}
      <li data-state={at === pub.rounds.length ? 'now' : 'next'}>Results</li>
    </ol>
  );
}

function Stage(props: StageProps) {
  const { pub, run } = props;
  const round = pub.round;
  if (pub.phase === 'lobby') return <LobbyStage {...props} />;
  if (pub.phase === 'finished') return <FinishedStage {...props} />;
  if (pub.phase === 'standings') {
    const next = pub.rounds[pub.roundIndex + 1];
    return (
      <StageCard eyebrow={`End of round ${pub.roundIndex + 1}`} title="Standings are on screen">
        {pub.eliminatedNow.length > 0 && (
          <p>
            Eliminated: <strong>{pub.eliminatedNow.map((id) => props.players[id]?.name).join(', ')}</strong>. Restore anyone from the player list if that was wrong.
          </p>
        )}
        <div className="hc-actions">
          <Button variant="primary" size="l" hotkey="Space" onClick={() => run({ t: 'round.next' })}>
            Next: {next?.title}
          </Button>
          <Button variant="ghost" onClick={() => confirm('End the game now and show the results?') && run({ t: 'game.end' })}>
            End game here
          </Button>
        </div>
      </StageCard>
    );
  }
  if (!round) return null;
  if (round.stage === 'intro') {
    return (
      <StageCard eyebrow={`Round ${pub.roundIndex + 1} of ${pub.rounds.length}`} title={round.title}>
        <p>{roundBlurb(round)}. The title card is on the TV — begin when you have introduced the round.</p>
        <IntroCategories pub={pub} round={round} />
        <div className="hc-actions">
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'round.begin' })}>
            Begin round
          </Button>
        </div>
      </StageCard>
    );
  }
  const secret = props.host.round;
  if (round.mode === 'trivia' && secret?.mode === 'trivia') return <TriviaStage {...props} round={round} secret={secret} />;
  if (round.mode === 'fastMoney' && secret?.mode === 'fastMoney') return <FastMoneyStage {...props} round={round} secret={secret} />;
  if (round.mode === 'final' && secret?.mode === 'final') return <FinalStage {...props} round={round} secret={secret} />;
  return null;
}

/**
 * The categories of the round being introduced. Until the round begins, any one of them can be swapped for
 * another drawn at random from the game's packs; the rest stay as they are. Holding a title shows its description.
 */
function IntroCategories({ pub, round }: { pub: PublicView; round: NonNullable<PublicView['round']> }) {
  const [busy, setBusy] = useState(false);
  const { peek, holdable } = usePeek();
  const cats = round.mode === 'trivia' ? round.board : round.mode === 'final' ? [{ title: round.category, blurb: undefined }] : [];
  if (!cats.length) return null;
  const peeked = peek === null ? null : cats[peek];
  const reroll = async (cat: number) => {
    setBusy(true);
    try {
      await api.reroll(pub.code, cat);
    } catch (err) {
      toast(err instanceof ApiFailure ? err.message : 'Could not change the category', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hc-cats">
      <div className="hc-cats__list">
        <ul aria-label={cats.length > 1 ? 'Categories' : 'Category'}>
          {cats.map((cat, i) => (
            <li key={cat.title}>
              {cat.blurb ? (
                <strong {...holdable(i)} aria-description={cat.blurb}>
                  {cat.title}
                </strong>
              ) : (
                <strong>{cat.title}</strong>
              )}
              <Button size="s" variant="ghost" disabled={busy || pub.paused} onClick={() => reroll(i)} aria-label={`Reroll ${cat.title}`}>
                Reroll
              </Button>
            </li>
          ))}
        </ul>
        {peeked?.blurb && (
          <div className="hc-board__blurb" aria-hidden>
            <strong>{peeked.title}</strong>
            {peeked.blurb}
          </div>
        )}
      </div>
      <p className="hc-note">
        Not keen on {cats.length > 1 ? 'one' : 'it'}? Reroll swaps {cats.length > 1 ? 'that category' : 'it'} for another from the pack at random{cats.length > 1 && ', and leaves the rest alone'}.
        {cats.some((cat) => cat.blurb) && ' Hold a title to read its description.'}
      </p>
    </div>
  );
}

function StageCard({ eyebrow, title, children, tone }: { eyebrow?: string; title?: ReactNode; children?: ReactNode; tone?: 'buzz' }) {
  return (
    <section className="hc-card hc-stage" data-tone={tone}>
      {eyebrow && <span className="bz-eyebrow">{eyebrow}</span>}
      {title && <h1>{title}</h1>}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- lobby & finish

function LobbyStage({ pub, run }: StageProps) {
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  useEffect(() => {
    api.info().then((i) => setPublicUrl(i.publicUrl), () => undefined);
  }, []);
  const join = joinAddress(publicUrl);
  const ready = pub.players.filter((p) => p.ready).length;
  const waiting = notReady(pub.players);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${join.url}/join/${pub.code}`);
      toast('Join link copied', 'good');
    } catch {
      toast(`${join.url}/join/${pub.code}`);
    }
  };
  return (
    <StageCard eyebrow="Lobby" title={pub.players.length ? `${plural(pub.players.length, 'player')} in the room` : 'Waiting for players'}>
      <div className="hc-lobby">
        <div className="hc-lobby__code">
          <span className="bz-eyebrow">Room code</span>
          <b>{pub.code}</b>
          <span>
            Players go to <strong>{join.label}</strong>
          </span>
        </div>
        <ol className="hc-lobby__steps">
          <li>
            Put the lobby on the big screen: <a href={`/tv/${pub.code}`} target="_blank" rel="noreferrer">open the TV view ↗</a> and make it full screen. Click it once to turn sound on.
          </li>
          <li>
            Friends scan the QR code or enter the room code. <button className="hc-link" onClick={copy}>Copy join link</button>
          </li>
          <li>
            Everyone taps <strong>I’m ready</strong> on their phone, then you start the show
            {pub.players.length > 0 && ` — ${ready} of ${pub.players.length} ready so far`}.
          </li>
        </ol>
      </div>
      <div className="hc-actions">
        <Button variant="primary" size="l" hotkey="Space" disabled={!canStart(pub.players)} onClick={() => run({ t: 'start' })}>
          Start the show
        </Button>
        <label className="bz-toggle">
          <input
            type="checkbox"
            checked={pub.lobbyLocked}
            onChange={(e) => {
              void run({ t: 'lobby.lock', locked: e.target.checked });
              letGo(e.target);
            }}
          />
          Lock the room
        </label>
        {pub.teams && (
          <Button variant="ghost" onClick={() => run({ t: 'teams.shuffle' })}>
            Shuffle teams
          </Button>
        )}
      </div>
      {pub.players.length > 0 && !canStart(pub.players) && (
        <p className="hc-note" role="status">
          {waiting.length ? (
            <>
              Waiting for <strong>{waiting.map((p) => p.name).join(', ')}</strong> to tap ready. Someone who is not playing after all? Click them in the
              player list and remove them.
            </>
          ) : (
            'Nobody has tapped ready yet.'
          )}
        </p>
      )}
      {pub.teams && (
        <ul className="hc-teams">
          {pub.teams.map((t) => (
            <li key={t.id}>
              <TeamName name={t.name} onSave={(name) => run({ t: 'team.rename', teamId: t.id, name })} />
              <span>{t.playerIds.length ? t.playerIds.map((id) => pub.players.find((p) => p.id === id)?.name).join(', ') : 'Nobody yet'}</span>
            </li>
          ))}
        </ul>
      )}
    </StageCard>
  );
}

function TeamName({ name, onSave }: { name: string; onSave: (name: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <input
      className="bz-input"
      value={value}
      maxLength={24}
      aria-label="Team name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value.trim() && value !== name && onSave(value.trim())}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

function FinishedStage({ pub, players }: StageProps) {
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const setup = storage.gameSetup(pub.code);
  const champions = (pub.champions ?? []).map((id) => players[id]?.name).filter(Boolean);
  const again = async () => {
    if (!setup) return navigate(`/host/new?rematch=${pub.code}`);
    setBusy(true);
    try {
      // Same rules and packs; fresh questions are drawn where the pack has spares.
      await api.rematch(pub.code, { packIds: setup.packIds, rules: setup.rules });
      toast('New game ready — everyone is back in the lobby', 'good');
    } catch (err) {
      toast(err instanceof ApiFailure ? err.message : 'Could not start a new game', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <StageCard eyebrow="That’s the show" title={champions.length ? `${champions.join(' & ')} ${champions.length > 1 ? 'win' : 'wins'}!` : 'Game over'} tone="buzz">
      <p>The results are on the big screen and saved to your history. Players stay connected, so another game is one click away.</p>
      <div className="hc-actions">
        <Button variant="primary" size="l" disabled={busy} onClick={again}>
          Play again
        </Button>
        <Link className="bz-btn bz-btn--ghost" href={`/host/new?rematch=${pub.code}`}>
          Change rules or pack
        </Link>
        <Link className="bz-btn bz-btn--ghost" href="/host/history">
          History
        </Link>
      </div>
      <ol className="hc-final">
        {placings(pub.players, pub.champions).map(({ player: p, place }) => (
          <li key={p.id}>
            <span className="bz-num">{place}</span>
            <Avatar avatar={p.avatar} size={30} />
            <strong>{p.name}</strong>
            {pub.champions?.includes(p.id) && <span className="bz-pill bz-pill--buzz">Champion</span>}
            <span className="bz-num">{fmtScore(p.score)}</span>
          </li>
        ))}
      </ol>
    </StageCard>
  );
}

// ---------------------------------------------------------------- roster

function Roster({ pub, snap, run, onManage }: StageProps & { onManage: (id: string) => void }) {
  const round = pub.round;
  const control = round?.mode === 'trivia' ? round.controlId : null;
  const answering = round?.mode === 'trivia' ? (round.clue?.answererId ?? null) : null;
  // Nudge scores by the smallest clue on the board, which is the usual unit of a correction.
  const step = round?.mode === 'trivia' ? Math.min(...round.board.flatMap((c) => c.clues.map((cl) => cl.value)).filter((v) => v > 0), 1000) : 100;
  const list = pub.phase === 'lobby' ? pub.players : byScore(pub.players);

  return (
    <section className="hc-card hc-roster">
      <h2 className="bz-eyebrow">
        Players <span>{pub.players.filter((p) => p.connected).length}/{pub.players.length} online</span>
      </h2>
      {list.length === 0 && <p className="hc-note">Nobody has joined yet.</p>}
      <ul>
        {list.map((p) => {
          const net = snap.net[p.id];
          return (
            <li key={p.id} className={cx(answering === p.id && 'is-answering')} data-out={p.eliminated || undefined}>
              <button className="hc-roster__who" onClick={() => onManage(p.id)} title="Manage player">
                <Avatar avatar={p.avatar} size={34} dim={!p.connected || p.eliminated} />
                <span>
                  <strong>
                    {p.name}
                    {control === p.id && <i className="bz-pill bz-pill--cyan">board</i>}
                    {pub.phase === 'lobby' && p.ready && <i className="bz-pill bz-pill--good">ready</i>}
                  </strong>
                  <small>
                    {!p.connected ? <em>offline</em> : net ? <span className="bz-mono">{net.rttMs} ms ±{Math.round(net.jitterMs / 2)}</span> : 'online'}
                    {p.eliminated && ' · eliminated'}
                    {pub.teams && p.teamId !== null && ` · ${pub.teams[p.teamId]?.name}`}
                  </small>
                </span>
              </button>
              <div className="hc-roster__score">
                <button onClick={() => run({ t: 'score.adjust', id: p.id, delta: -step })} aria-label={`Take ${step} from ${p.name}`}>
                  −
                </button>
                <Score value={p.score} />
                <button onClick={() => run({ t: 'score.adjust', id: p.id, delta: step })} aria-label={`Give ${step} to ${p.name}`}>
                  +
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {pub.teams && pub.phase !== 'lobby' && (
        <ul className="hc-roster__teams">
          {pub.teams.map((t) => (
            <li key={t.id}>
              {t.name} <b className="bz-num">{fmtScore(t.score)}</b>
            </li>
          ))}
        </ul>
      )}
      <p className="hc-note">Ping is the server-measured round trip to each phone. Click a player to rename, eliminate, give control or remove them.</p>
    </section>
  );
}

function ManagePlayer({ pub, run, player, onClose }: StageProps & { player: PublicPlayer; onClose: () => void }) {
  const [name, setName] = useState(player.name);
  // The score as it stood when the dialog opened: only a figure the host actually typed is ever sent.
  const [opened] = useState(String(player.score));
  const [score, setScore] = useState(opened);
  const trivia = pub.round?.mode === 'trivia';
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const typed = score.trim();
    const value = Number(typed);
    if (typed && !Number.isInteger(value)) return toast('Enter the score as a whole number', 'error');
    let ok = true;
    if (name.trim() && name.trim() !== player.name) ok = await run({ t: 'player.rename', id: player.id, name: name.trim() });
    if (ok && typed && typed !== opened) ok = await run({ t: 'score.set', id: player.id, score: value });
    if (ok) onClose();
  };
  const then = (action: HostAction) => run(action).then((ok) => ok && onClose());
  return (
    <Modal title={player.name} onClose={onClose}>
      <form className="hc-manage" onSubmit={save}>
        <label className="bz-field">
          <span>Name</span>
          <input className="bz-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={16} />
        </label>
        <label className="bz-field">
          <span>Score</span>
          <input className="bz-input" type="number" step={1} value={score} onChange={(e) => setScore(e.target.value)} />
        </label>
        {pub.teams && (
          <label className="bz-field">
            <span>Team</span>
            <select className="bz-select" value={player.teamId ?? ''} onChange={(e) => run({ t: 'player.team', id: player.id, teamId: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">No team</option>
              {pub.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="hc-manage__row">
          {trivia && (
            <Button variant="ghost" onClick={() => then({ t: 'control.set', id: player.id })}>
              Give control of the board
            </Button>
          )}
          {pub.phase !== 'lobby' && (
            <Button variant="ghost" onClick={() => then({ t: 'player.eliminate', id: player.id, eliminated: !player.eliminated })}>
              {player.eliminated ? 'Bring back into the game' : 'Eliminate'}
            </Button>
          )}
          <Button variant="bad" onClick={() => confirm(`Remove ${player.name} from the game? Their score is lost.`) && then({ t: 'player.kick', id: player.id })}>
            Remove from game
          </Button>
        </div>
        <div className="bz-modal__actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
