import type { PublicPlayer, PublicView } from '@buzzoff/shared';

const whole = new Intl.NumberFormat('en-US');

export const fmtScore = (n: number) => (n < 0 ? `−${whole.format(-n)}` : whole.format(n));
export const fmtDelta = (n: number) => (n < 0 ? `−${whole.format(-n)}` : `+${whole.format(n)}`);

/** A server-recorded buzz time, e.g. "327 ms" or "1.24 s". */
export function fmtMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** The gap to the winning buzz, e.g. "+28 ms". */
export function fmtGap(ms: number): string {
  const rounded = Math.round(ms);
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded)} ms`;
}

export const fmtPercent = (ratio: number | null) => (ratio === null ? '—' : `${Math.round(ratio * 100)}%`);

export const playerMap = (pub: PublicView): Record<string, PublicPlayer> => Object.fromEntries(pub.players.map((p) => [p.id, p]));

/** Players by score, highest first, keeping join order between equals. */
export const byScore = (players: PublicPlayer[]) => [...players].sort((a, b) => b.score - a.score);

export const ordinal = (n: number) => {
  const tail = n % 100;
  const suffix = tail >= 11 && tail <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const fmtDay = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Where players should go to join, shown on the lobby screen. */
export function joinAddress(publicUrl: string | null): { url: string; label: string } {
  const base = (publicUrl ?? window.location.origin).replace(/\/+$/, '');
  return { url: base, label: base.replace(/^https?:\/\//, '') };
}
