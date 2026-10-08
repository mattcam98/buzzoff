import type { GameEvent, TimerView } from '@buzzoff/shared';
import { useEffect, useReducer, useRef } from 'react';
import type { Connection } from './connection';

interface Countdown {
  /** Milliseconds left, never negative. */
  remaining: number;
  /** 1 at the start, 0 when time is up. */
  fraction: number;
  seconds: number;
}

/**
 * A countdown against the server clock. It re-renders every animation frame
 * while time is running, and not at all once it is up or the game is paused.
 */
export function useCountdown(timer: TimerView | null, clockOffset: number, pausedAt: number | null): Countdown | null {
  const [, frame] = useReducer((n: number) => n + 1, 0);
  const remaining = timer ? Math.max(0, timer.endsAt - (pausedAt ?? Date.now() + clockOffset)) : 0;
  const running = remaining > 0 && pausedAt === null;
  useEffect(() => {
    if (!running) return;
    let id = requestAnimationFrame(function loop() {
      frame();
      id = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, [running]);
  if (!timer) return null;
  return { remaining, fraction: Math.min(1, remaining / timer.totalMs), seconds: Math.ceil(remaining / 1000) };
}

/** Subscribe to one-shot game events for the lifetime of a component. */
export function useGameEvents(conn: Connection, handler: (event: GameEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => conn.onEvent((e) => latest.current(e)), [conn]);
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
    let done = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen');
        // The request can resolve after the screen that asked for it has gone.
        if (done) void lock?.release();
      } catch {
        /* unsupported or refused: nothing to do */
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release();
    };
  }, []);
}
