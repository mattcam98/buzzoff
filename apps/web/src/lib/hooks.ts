import type { GameEvent, TimerView } from '@buzzoff/shared';
import { useEffect, useReducer, useRef, useState } from 'react';
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

/**
 * Full screen for a page that is put up on a television: whether it is on, a
 * way to switch it, and whether this browser can do it at all (an iPhone cannot).
 */
export function useFullscreen() {
  const [on, setOn] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const sync = () => setOn(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  // Refused when it does not come from a click or a key press; there is nothing to do about that.
  const toggle = () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => undefined);
  return { on, toggle, supported: document.fullscreenEnabled === true };
}

/** True while the mouse or keyboard is in use and for a few seconds after: for controls that should not sit on a screen nobody is touching. */
export function useRecentInput(ms = 3000) {
  const [recent, setRecent] = useState(true);
  useEffect(() => {
    let timer = window.setTimeout(() => setRecent(false), ms);
    const wake = () => {
      setRecent(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRecent(false), ms);
    };
    const events = ['pointermove', 'pointerdown', 'keydown'] as const;
    for (const type of events) window.addEventListener(type, wake);
    return () => {
      window.clearTimeout(timer);
      for (const type of events) window.removeEventListener(type, wake);
    };
  }, [ms]);
  return recent;
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
