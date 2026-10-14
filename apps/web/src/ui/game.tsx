/** Game-specific pieces shared by the TV, the phones and the host console. */
import type { Media, PublicAttempt, PublicPlayer, PublicView, RoundPublic } from '@buzzoff/shared';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Snapshot } from '../lib/connection';
import { fmtGap, fmtMs, fmtScore, plural } from '../lib/format';
import { useCountdown } from '../lib/hooks';
import { play } from '../lib/sound';
import { Avatar, cx } from './kit';

/** Tween towards a number so score changes are seen, not just read. */
function useAnimatedNumber(target: number, durationMs = 700): number {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    if (origin === target) return;
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      const value = Math.round(origin + (target - origin) * eased);
      from.current = value;
      setShown(value);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return shown;
}

export function Score({ value, className }: { value: number; className?: string }) {
  const shown = useAnimatedNumber(value);
  return (
    <span className={cx('bz-num', className)} data-negative={value < 0 || undefined}>
      {fmtScore(shown)}
    </span>
  );
}

/**
 * The buzz order for the current clue. Times are what the server recorded
 * when each buzz reached it: honest about being that, and nothing more.
 */
export function BuzzLadder({ attempts, players, adjusted, limit = 6 }: {
  attempts: PublicAttempt[];
  players: Record<string, PublicPlayer>;
  /** Latency-adjusted arbitration: show the adjusted figure that decided the order. */
  adjusted: boolean;
  limit?: number;
}) {
  if (!attempts.length) return null;
  return (
    <ol className="bz-ladder" aria-label="Buzz order, as recorded by the server">
      {attempts.slice(0, limit).map((a, i) => {
        const p = players[a.playerId];
        if (!p) return null;
        return (
          <li key={a.playerId} data-winner={a.winner || undefined} style={{ animationDelay: `${i * 70}ms` }}>
            <Avatar avatar={p.avatar} size="1.9em" />
            <span className="bz-ladder__name">{p.name}</span>
            <span className="bz-mono bz-ladder__ms">{fmtMs(adjusted && a.adjustedMs !== null ? a.adjustedMs : a.ms)}</span>
            <span className="bz-mono bz-ladder__gap">{a.winner ? 'first' : fmtGap(a.deltaMs)}</span>
          </li>
        );
      })}
      {attempts.length > limit && <li className="bz-ladder__more">+{attempts.length - limit} more</li>}
    </ol>
  );
}

/** One line describing what a round is, for intros and the host's run-down. */
export function roundBlurb(round: RoundPublic): string {
  if (round.mode === 'trivia') {
    const clues = round.board[0]?.clues.length ?? 0;
    return `${plural(round.board.length, 'category', 'categories')} · ${plural(clues, 'question')} each${round.multiplier > 1 ? ` · ${round.multiplier}× points` : ''}`;
  }
  if (round.mode === 'final') return 'One question. Everybody wagers.';
  const who = round.participants === 'all' ? 'Everybody plays' : round.participants === 'top2' ? 'The top two go head to head' : 'The leader plays alone';
  return `${who} · survey says…`;
}

const roundTimer = ({ round }: PublicView) => (round?.mode === 'trivia' ? (round.clue?.timer ?? null) : (round?.timer ?? null));

/** Ticks through the last five seconds of whatever countdown is running. Renders nothing. */
export function FinalSecondsTick({ pub, snap }: { pub: PublicView; snap: Snapshot }) {
  const seconds = useCountdown(roundTimer(pub), snap.clockOffset, pub.pausedAt)?.seconds ?? null;
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (seconds !== null && seconds <= 5 && seconds > 0 && last.current !== null && seconds < last.current) play('tick');
    last.current = seconds;
  }, [seconds]);
  return null;
}

/** A large seconds read-out for a server deadline. */
export function Seconds({ pub, snap, className }: { pub: PublicView; snap: Snapshot; className?: string }) {
  const count = useCountdown(roundTimer(pub), snap.clockOffset, pub.pausedAt);
  if (!count) return null;
  return (
    <span className={cx('bz-num', className)} data-low={count.seconds <= 5 || undefined} role="timer">
      {count.seconds}
    </span>
  );
}

/** Pick a type size for a question so long clues still fit the screen. */
export const textScale = (text: string) => (text.length > 220 ? 'xs' : text.length > 140 ? 's' : text.length > 70 ? 'm' : 'l');

/** The same for an answer on the shared screen. It is set larger than a question and in a narrower card, so it steps down sooner. */
export const answerScale = (text: string) => (text.length > 200 ? 'xs' : text.length > 110 ? 's' : text.length > 50 ? 'm' : 'l');

export function MediaView({ media, className }: { media: Media; className?: string }) {
  if (media.kind === 'image') return <img className={cx('bz-media', className)} src={media.url} alt="" />;
  if (media.kind === 'audio') {
    return (
      <div className={cx('bz-media bz-media--audio', className)}>
        <span aria-hidden>🎧</span>
        <audio src={media.url} autoPlay controls />
      </div>
    );
  }
  return <video className={cx('bz-media', className)} src={media.url} autoPlay controls playsInline />;
}

const TUMBLE_MS = 850;
const PIPS = Array.from({ length: 9 }, (_, i) => <i key={i} />);
/** How the cube is turned to bring each of its faces to the front: degrees about the horizontal axis, then the vertical. */
const TURNS: [x: number, y: number][] = [[0, 0], [0, 0], [-90, 0], [0, -90], [0, 90], [90, 0], [0, 180]];

/**
 * A six-sided die. The number always comes from the server; when one arrives the die
 * is thrown, a cube that turns over in the air and lands on it, which is for show and
 * nothing else. At rest it is the one flat face, so a room full of dice costs no more than it did.
 */
export function Die({ value, className }: { value: number | null; className?: string }) {
  const [tumbling, setTumbling] = useState(false);
  const shown = useRef(value);
  useEffect(() => {
    if (value === shown.current) return;
    shown.current = value;
    if (value === null || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setTumbling(true);
    const timer = window.setTimeout(() => setTumbling(false), TUMBLE_MS);
    return () => {
      window.clearTimeout(timer);
      setTumbling(false);
    };
  }, [value]);
  const [x, y] = TURNS[value ?? 0];
  return (
    <span className={cx('bz-die', className)} data-face={value ?? 0} data-tumbling={tumbling || undefined} role="img" aria-label={value === null ? 'Not rolled yet' : `Rolled a ${value}`}>
      {tumbling ? (
        <span className="bz-die__cube" style={{ '--turn-x': `${x}deg`, '--turn-y': `${y}deg` } as CSSProperties}>
          {[1, 2, 3, 4, 5, 6].map((side) => (
            <span key={side} className="bz-die__side" data-face={side}>
              {PIPS}
            </span>
          ))}
        </span>
      ) : (
        PIPS
      )}
    </span>
  );
}

/** The players level on the highest roll: the ones who go again after a tie. */
export function rollLeaders(roll: { contenders: string[]; rolls: Record<string, number> }): string[] {
  const best = Math.max(0, ...roll.contenders.map((id) => roll.rolls[id] ?? 0));
  return best ? roll.contenders.filter((id) => roll.rolls[id] === best) : [];
}
