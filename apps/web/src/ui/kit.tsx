/** The shared component kit. Styles live in styles/base.css under the `bz-` prefix. */
import type { Avatar as AvatarData, TimerView } from '@buzzoff/shared';
import {
  useEffect, useRef, useSyncExternalStore,
  type ButtonHTMLAttributes, type CSSProperties, type ReactNode,
} from 'react';
import { Link } from 'wouter';
import { useCountdown } from '../lib/hooks';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
export { cx };

/** Without a `size` the logo takes its size from the surrounding CSS. */
export function Logo({ size, to }: { size?: number; to?: string }) {
  const inner = (
    <>
      <i className="bz-logo__mark" aria-hidden />
      <span>
        Buzz<span className="bz-logo__off">Off</span>
      </span>
    </>
  );
  return to ? (
    <Link className="bz-logo" style={size ? { fontSize: size } : undefined} href={to} aria-label="BuzzOff home">
      {inner}
    </Link>
  ) : (
    <span className="bz-logo" style={size ? { fontSize: size } : undefined}>
      {inner}
    </span>
  );
}

export function Avatar({ avatar, size = 48, dim, className }: { avatar: AvatarData; size?: number | string; dim?: boolean; className?: string }) {
  const style = { '--size': typeof size === 'number' ? `${size}px` : size, '--tone': avatar.color } as CSSProperties;
  return (
    <span className={cx('bz-avatar', className)} style={style} data-dim={dim || undefined} aria-hidden>
      <span>{avatar.emoji}</span>
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'good' | 'bad' | 'pink' | 'ghost';
  size?: 's' | 'm' | 'l';
  block?: boolean;
  icon?: boolean;
  /** Keyboard shortcut hint shown inside the button. */
  hotkey?: string;
};

export function Button({ variant = 'default', size = 'm', block, icon, hotkey, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('bz-btn', variant !== 'default' && `bz-btn--${variant}`, size !== 'm' && `bz-btn--${size}`, block && 'bz-btn--block', icon && 'bz-btn--icon', className)}
      // Screens with keyboard shortcuts find their target by this attribute, so a
      // shortcut can only ever do what a visible, enabled button would do.
      data-hotkey={hotkey?.toLowerCase()}
      {...rest}
    >
      {children}
      {hotkey && <kbd className="bz-kbd">{hotkey === 'Space' ? '␣' : hotkey}</kbd>}
    </button>
  );
}

/** A draining bar for a server-side deadline. */
export function TimerBar({ timer, clockOffset, pausedAt, className }: { timer: TimerView | null; clockOffset: number; pausedAt: number | null; className?: string }) {
  const count = useCountdown(timer, clockOffset, pausedAt);
  if (!count) return null;
  return (
    <div className={cx('bz-timer', className)} data-low={count.remaining < 3000 || undefined} role="timer" aria-label={`${count.seconds} seconds left`}>
      <i style={{ transform: `scaleX(${count.fraction})` }} />
    </div>
  );
}

export function Modal({ title, children, onClose, width }: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="bz-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="bz-modal__panel" role="dialog" aria-modal="true" aria-label={title} style={width ? ({ '--modal-width': `${width}px` } as CSSProperties) : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Full-screen message for loading, errors and dead ends. */
export function Notice({ title, children, busy }: { title: string; children?: ReactNode; busy?: boolean }) {
  return (
    <main className="bz-stage bz-center">
      <div className="bz-rise">
        {busy ? <i className="bz-spinner" aria-hidden /> : <Logo size={30} to="/" />}
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'good';
}
let toasts: Toast[] = [];
let nextToast = 1;
const toastListeners = new Set<() => void>();
const emitToasts = () => toastListeners.forEach((fn) => fn());

/** Show a brief message at the bottom of the screen. */
export function toast(text: string, kind: Toast['kind'] = 'info') {
  // Repeating the same message (say, a hammered button) refreshes it rather than stacking.
  toasts = [...toasts.filter((t) => t.text !== text), { id: nextToast++, text, kind }].slice(-3);
  const { id } = toasts[toasts.length - 1];
  emitToasts();
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  }, 3600);
}

export function Toasts() {
  const list = useSyncExternalStore(
    (fn) => {
      toastListeners.add(fn);
      return () => toastListeners.delete(fn);
    },
    () => toasts,
  );
  return (
    <div className="bz-toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="bz-toast" data-kind={t.kind}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- confetti

const CONFETTI_COLORS = ['#FFC400', '#FF4D8D', '#3DDCFF', '#58E88A', '#B58CFF', '#FFFFFF'];

/** A burst of confetti each time `burst` changes to a new truthy value. */
export function Confetti({ burst }: { burst: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!burst || !canvas || !g || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = (canvas.width = canvas.clientWidth * dpr);
    const h = (canvas.height = canvas.clientHeight * dpr);
    const pieces = Array.from({ length: 220 }, (_, i) => {
      const fromLeft = i % 2 === 0;
      const angle = (fromLeft ? -Math.PI / 3 : (-2 * Math.PI) / 3) + (Math.random() - 0.5) * 0.9;
      const speed = (9 + Math.random() * 16) * dpr;
      return {
        x: fromLeft ? 0 : w, y: h * 0.85, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        size: (6 + Math.random() * 8) * dpr, spin: Math.random() * Math.PI, vs: (Math.random() - 0.5) * 0.4,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], hex: i % 3 === 0,
      };
    });
    let frame = 0;
    let raf = requestAnimationFrame(function draw() {
      g.clearRect(0, 0, w, h);
      for (const p of pieces) {
        p.vy += 0.32 * dpr;
        p.vx *= 0.992;
        p.x += p.vx;
        p.y += p.vy;
        p.spin += p.vs;
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.spin);
        g.scale(1, Math.cos(p.spin * 2.3));
        g.fillStyle = p.color;
        if (p.hex) {
          g.beginPath();
          for (let k = 0; k < 6; k++) g.lineTo((Math.cos((k * Math.PI) / 3) * p.size) / 2, (Math.sin((k * Math.PI) / 3) * p.size) / 2);
          g.fill();
        } else {
          g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        g.restore();
      }
      if (++frame < 260) raf = requestAnimationFrame(draw);
      else g.clearRect(0, 0, w, h);
    });
    return () => cancelAnimationFrame(raf);
  }, [burst]);
  return <canvas ref={ref} aria-hidden style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 60 }} />;
}
