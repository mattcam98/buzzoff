/**
 * The lit floor behind the shared screen. The flat backdrop every page has is already there when
 * this mounts; the floor is fetched afterwards and fades in over it, and where it cannot be drawn
 * (no WebGL, or the browser takes it away) the flat backdrop is simply what stays.
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { Hive, Quality } from './hive';
import { LOOKS, type Lighting, type Ripple } from './lighting';

export interface StageHandle {
  ripple: (ripple: Ripple) => void;
}

export function Stage({ lighting, dimmed, onQuality, ref }: {
  lighting: Lighting;
  /** Hold the lights low and the floor still: the game is paused. */
  dimmed: boolean;
  /** How the floor is being drawn, or null once it is known that it cannot be. */
  onQuality: (quality: Quality | null) => void;
  ref?: Ref<StageHandle>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const hive = useRef<Hive | null>(null);
  const [lit, setLit] = useState(false);
  const want = useRef({ lighting, dimmed, onQuality });
  want.current = { lighting, dimmed, onQuality };

  useEffect(() => {
    let gone = false;
    const el = canvas.current!;
    const fail = () => {
      hive.current?.dispose();
      hive.current = null;
      setLit(false);
      want.current.onQuality(null);
    };
    import('./hive').then(({ createHive }) => {
      if (gone) return;
      try {
        hive.current = createHive(el, {
          still: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          onQuality: (quality) => want.current.onQuality(quality),
          onLost: fail,
        });
        hive.current.light(LOOKS[want.current.lighting], want.current.dimmed);
        setLit(true);
      } catch {
        fail();
      }
    }, fail);
    return () => {
      gone = true;
      hive.current?.dispose();
      hive.current = null;
    };
  }, []);

  useEffect(() => hive.current?.light(LOOKS[lighting], dimmed), [lighting, dimmed]);

  useImperativeHandle(ref, () => ({
    ripple({ color, strength, from }) {
      // The event arrives a moment before the screen has drawn what it changed, so the player is looked for after it has.
      window.setTimeout(() => {
        const el = canvas.current;
        if (!el || !hive.current) return;
        const screen = el.getBoundingClientRect();
        const under = from === 'centre' ? null : el.parentElement?.querySelector(`[data-player="${CSS.escape(from.player)}"]`)?.getBoundingClientRect();
        const x = under ? (under.left + under.width / 2 - screen.left) / screen.width : 0.5;
        const y = under ? (under.top + under.height / 2 - screen.top) / screen.height : 0.6;
        hive.current.ripple(x, y, color, strength);
      }, 90);
    },
  }), []);

  return <canvas ref={canvas} className="bz-stage3d" data-lit={lit || undefined} aria-hidden />;
}
