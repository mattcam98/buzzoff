import type { GameEvent, TimerView } from '@buzzoff/shared';
import { useEffect, useRef, useState } from 'react';
import type { Connection } from './connection';

/** Re-render on every animation frame while `active`, returning server time. */
export function useServerNow(clockOffset: number, active = true): number {
  const [now, setNow] = useState(() => Date.now() + clockOffset);
  useEffect(() => {
    if (!active) return;
    let frame = requestAnimationFrame(function loop() {
      setNow(Date.now() + clockOffset);
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [clockOffset, active]);
  return now;
}

export interface Countdown {
  /** Milliseconds left, never negative. */
  remaining: number;
  /** 1 at the start, 0 when time is up. */
  fraction: number;
  seconds: number;
}

/** A countdown against the server clock. It freezes while the game is paused. */
export function useCountdown(timer: TimerView | null, clockOffset: number, pausedAt: number | null): Countdown | null {
  const now = useServerNow(clockOffset, !!timer && pausedAt === null);
  if (!timer) return null;
  const remaining = Math.max(0, timer.endsAt - (pausedAt ?? now));
  return { remaining, fraction: Math.min(1, remaining / timer.totalMs), seconds: Math.ceil(remaining / 1000) };
}

/** Subscribe to one-shot game events for the lifetime of a component. */
export function useGameEvents(conn: Connection, handler: (event: GameEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => conn.onEvent((e) => latest.current(e)), [conn]);
}

/** Remember the previous value of something across renders. */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

/** Run a handler for a keyboard shortcut, ignoring keys typed into form fields. */
export function useHotkeys(handler: (key: string, event: KeyboardEvent) => void, enabled = true) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      latest.current(e.key.length === 1 ? e.key.toLowerCase() : e.key, e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** Ask the browser not to dim or lock the screen, where it is able to. */
export function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen');
      } catch {
        /* unsupported or refused: nothing to do */
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release();
    };
  }, []);
}
