/**
 * The front door, in two steps that each fit one screen: the room code, then
 * who you are. A QR code or `/join/CODE` link lands straight on the second.
 */
import {
  AVATAR_COLORS, AVATAR_EMOJI, normalizeRoomCode, ROOM_CODE_LENGTH,
  type Avatar as AvatarData, type GameInfo,
} from '@buzzoff/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { api, ApiFailure } from '../lib/api';
import { plural } from '../lib/format';
import { unlockAudio } from '../lib/sound';
import { storage } from '../lib/storage';
import { useFixedViewport } from '../lib/viewport';
import { Avatar, Button, Logo } from '../ui/kit';
import '../styles/home.css';

/** What each avatar colour is called out loud; a hex code tells a screen reader's user nothing. */
const COLOR_NAMES: Record<AvatarData['color'], string> = {
  '#FFC400': 'Amber', '#FF4D8D': 'Pink', '#3DDCFF': 'Sky blue', '#7CFF6B': 'Green', '#B58CFF': 'Violet',
  '#FF8A3D': 'Orange', '#4D7CFF': 'Blue', '#FF5C5C': 'Red', '#2EE6A6': 'Mint', '#F2F2F2': 'White',
};

const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
const randomAvatar = (): AvatarData => ({ emoji: pick(AVATAR_EMOJI), color: pick(AVATAR_COLORS) });

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'found'; game: GameInfo } | { state: 'missing'; message: string };

/** Name, emoji and colour pickers, shared with the in-game profile editor. */
export function IdentityFields({ name, avatar, onName, onAvatar, nameRef }: {
  name: string;
  avatar: AvatarData;
  onName: (name: string) => void;
  onAvatar: (avatar: AvatarData) => void;
  nameRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <>
      <div className="home__name">
        <Avatar avatar={avatar} size={52} />
        <input
          ref={nameRef}
          className="bz-input"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          maxLength={16}
          autoComplete="nickname"
          autoCapitalize="words"
          enterKeyHint="go"
        />
        <button type="button" className="home__dice" onClick={() => onAvatar(randomAvatar())} aria-label="Surprise me with a random avatar">
          🎲
        </button>
      </div>
      {/* On short screens this becomes a sideways strip; while typing it steps aside entirely. */}
      <div className="home__emoji" role="radiogroup" aria-label="Avatar" data-scroll>
        {AVATAR_EMOJI.map((emoji) => (
          <button key={emoji} type="button" role="radio" aria-checked={avatar.emoji === emoji} onClick={() => onAvatar({ ...avatar, emoji })}>
            {emoji}
          </button>
        ))}
      </div>
      {/* Each swatch is a full-size touch target with a smaller dot inside; the row scrolls sideways if it must. */}
      <div className="home__colors" role="radiogroup" aria-label="Colour" data-scroll>
        {AVATAR_COLORS.map((color) => (
          <button key={color} type="button" role="radio" aria-checked={avatar.color === color} aria-label={COLOR_NAMES[color]} style={{ '--swatch': color } as React.CSSProperties} onClick={() => onAvatar({ ...avatar, color })} />
        ))}
      </div>
    </>
  );
}

export function Home({ code: initialCode = '' }: { code?: string }) {
  const [, navigate] = useLocation();
  const saved = useRef(storage.profile()).current;
  const [code, setCode] = useState(normalizeRoomCode(initialCode));
  const [name, setName] = useState(saved?.name ?? '');
  const [avatar, setAvatar] = useState<AvatarData>(saved?.avatar ?? randomAvatar);
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claim, setClaim] = useState<{ id: string; secret: string } | null>(null);
  const [changingCode, setChangingCode] = useState(false);
  const [, refresh] = useState(0);
  const [leaderboard, setLeaderboard] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useFixedViewport();

  // The standings are linked from here only where the host has opened them to players.
  useEffect(() => {
    api.info().then((info) => setLeaderboard(info.publicLeaderboard), () => undefined);
  }, []);

  const complete = code.length === ROOM_CODE_LENGTH;
  const seat = complete ? storage.seat(code) : null;

  // Look the room up as soon as the code is complete.
  useEffect(() => {
    setError(null);
    if (!complete) return setLookup({ state: 'idle' });
    let cancelled = false;
    setLookup({ state: 'loading' });
    api.game(code).then(
      (game) => {
        if (cancelled) return;
        setLookup({ state: 'found', game });
        setChangingCode(false);
      },
      (err: ApiFailure) => !cancelled && setLookup({ state: 'missing', message: err.status === 404 ? 'No game with that code' : err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [code, complete]);

  // A takeover request is waiting on the host: poll until they answer.
  useEffect(() => {
    if (!claim) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const status = await api.claim(code, claim.id, claim.secret);
        if (cancelled || status.status === 'pending') return;
        setClaim(null);
        if (status.status === 'approved') {
          storage.setSeat(code, { playerId: status.playerId, token: status.token });
          navigate(`/play/${code}`);
        } else {
          setError('The host did not approve that. Pick a different name to join as a new player.');
        }
      } catch (err) {
        // A dropped request is not an answer; only the server saying the request is gone ends the wait.
        if (cancelled || !(err instanceof ApiFailure) || err.status !== 404) return;
        setClaim(null);
        setError('That request expired. Try again.');
      }
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [claim, code, navigate]);

  async function join(e: FormEvent) {
    e.preventDefault();
    void unlockAudio();
    if (!complete || busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.join(code, { name, avatar });
      storage.setProfile({ name: name.trim(), avatar });
      if (res.status === 'joined') {
        storage.setSeat(code, { playerId: res.playerId, token: res.token });
        navigate(`/play/${code}`);
      } else {
        setClaim({ id: res.claimId, secret: res.claimSecret });
      }
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const game = lookup.state === 'found' ? lookup.game : null;
  const closed = !!game && !game.joinable && !seat;
  const step = claim ? 'claim' : game && !changingCode ? 'who' : 'code';
  const status = game && (
    <>
      <strong>{game.name}</strong> · {plural(game.playerCount, 'player')} {game.phase === 'lobby' ? 'in the lobby' : game.phase === 'finished' ? '· finished' : '· in progress'}
    </>
  );

  return (
    <main className="bz-stage bz-app home" data-step={step}>
      <header className="home__top">
        <Logo />
        <p>The quiz show that lives in your living room.</p>
      </header>

      <div className="home__body">
        {step === 'claim' && (
          <section className="bz-card home__card bz-pop" aria-live="polite">
            <i className="bz-spinner" aria-hidden />
            <h2>Waiting for the host</h2>
            <p className="home__hint">
              <strong>{name.trim()}</strong> is already in this game. The host has been asked to let you take over that seat.
            </p>
            <Button variant="ghost" onClick={() => setClaim(null)}>
              Cancel
            </Button>
          </section>
        )}

        {step === 'code' && (
          <section className="bz-card home__card bz-rise">
            <label className="home__code">
              <span className="bz-eyebrow">Room code</span>
              <input
                ref={codeInput}
                value={code}
                onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={ROOM_CODE_LENGTH + 2}
                placeholder={'•'.repeat(ROOM_CODE_LENGTH)}
                aria-describedby="room-status"
                enterKeyHint="go"
                autoFocus
              />
            </label>
            <p id="room-status" className="home__status" data-state={lookup.state} aria-live="polite">
              {lookup.state === 'idle' && 'Ask your host for the four letters on the big screen.'}
              {lookup.state === 'loading' && 'Looking…'}
              {lookup.state === 'missing' && lookup.message}
              {status}
            </p>
            {game && (
              <Button variant="primary" size="l" block onClick={() => setChangingCode(false)}>
                Continue
              </Button>
            )}
          </section>
        )}

        {step === 'who' && game && (
          <form className="bz-card home__card bz-rise" onSubmit={join}>
            <button type="button" className="home__room" onClick={() => setChangingCode(true)}>
              <b>{code}</b>
              <span id="room-status" data-state="found">
                {status}
              </span>
              <i>Change</i>
            </button>

            {seat ? (
              <div className="home__rejoin">
                <Button variant="primary" size="l" block onClick={() => navigate(`/play/${code}`)}>
                  Rejoin your game
                </Button>
                <button
                  type="button"
                  className="home__link"
                  onClick={() => {
                    storage.setSeat(code, null);
                    refresh((n) => n + 1);
                  }}
                >
                  Join as someone else
                </button>
              </div>
            ) : (
              <fieldset className="home__who" disabled={closed}>
                <IdentityFields name={name} avatar={avatar} onName={setName} onAvatar={setAvatar} />
                <Button type="submit" variant="primary" size="l" block disabled={!name.trim() || busy}>
                  {busy ? 'Joining…' : closed ? 'This game is closed' : 'Join game'}
                </Button>
              </fieldset>
            )}

            {error && (
              <p className="home__error" role="alert">
                {error}
              </p>
            )}
            <Link className="home__link home__extra" href={`/watch/${code}`}>
              Just watching? Open the spectator view
            </Link>
          </form>
        )}
      </div>

      <footer className="home__foot">
        <Link href="/host">Host a game</Link>
        <span aria-hidden>·</span>
        <Link href="/tv">Open a TV screen</Link>
        {leaderboard && (
          <>
            <span aria-hidden>·</span>
            <Link href="/leaderboard">Leaderboard</Link>
          </>
        )}
      </footer>
    </main>
  );
}
