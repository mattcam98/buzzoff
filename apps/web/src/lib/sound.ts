/**
 * Every sound in BuzzOff is synthesised here with the Web Audio API. There are
 * no audio files, so there is nothing to license and nothing to download.
 */
import type { CueName, GameEvent } from '@buzzoff/shared';

export type SoundName =
  | 'join' | 'select' | 'open' | 'buzz' | 'dice' | 'correct' | 'wrong' | 'timeup' | 'reveal' | 'ding' | 'strike'
  | 'intro' | 'fanfare' | 'tick' | 'lock' | CueName;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Browsers only allow audio after a user gesture; call this from a click or tap. */
export function unlockAudio() {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export const audioReady = () => ctx?.state === 'running';

interface Tone {
  freq: number;
  /** Glide to this frequency over the note. */
  to?: number;
  at?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
}

function tone(c: AudioContext, out: AudioNode, t0: number, n: Tone) {
  const start = t0 + (n.at ?? 0);
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = n.type ?? 'sine';
  osc.frequency.setValueAtTime(n.freq, start);
  if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, start + n.dur);
  const peak = n.gain ?? 0.3;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
  osc.connect(env).connect(out);
  osc.start(start);
  osc.stop(start + n.dur + 0.05);
}

function noise(c: AudioContext, out: AudioNode, t0: number, o: { at?: number; dur: number; gain?: number; from: number; to?: number; q?: number; pulse?: number }) {
  const start = t0 + (o.at ?? 0);
  const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * o.dur), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    // An optional tremolo turns hiss into a drum roll or the patter of applause.
    const pulse = o.pulse ? 0.55 + 0.45 * Math.sign(Math.sin((i / c.sampleRate) * Math.PI * 2 * o.pulse)) : 1;
    data[i] = (Math.random() * 2 - 1) * pulse;
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = o.q ?? 0.8;
  filter.frequency.setValueAtTime(o.from, start);
  if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, start + o.dur);
  const env = c.createGain();
  const peak = o.gain ?? 0.25;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.08, o.dur / 3));
  env.gain.setValueAtTime(peak, start + o.dur * 0.7);
  env.gain.exponentialRampToValueAtTime(0.0001, start + o.dur);
  src.connect(filter).connect(env).connect(out);
  src.start(start);
}

const chord = (freqs: number[], o: Omit<Tone, 'freq'>): Tone[] => freqs.map((freq) => ({ freq, ...o }));
const run = (freqs: number[], step: number, o: Omit<Tone, 'freq' | 'at'>): Tone[] => freqs.map((freq, i) => ({ freq, at: i * step, ...o }));

type Recipe = (c: AudioContext, out: AudioNode, t: number) => void;
const tones = (list: Tone[]): Recipe => (c, out, t) => list.forEach((n) => tone(c, out, t, n));

const RECIPES: Record<SoundName, Recipe> = {
  join: tones(run([523, 784], 0.07, { dur: 0.16, type: 'triangle', gain: 0.22 })),
  select: tones([{ freq: 330, to: 660, dur: 0.14, type: 'triangle', gain: 0.25 }]),
  open: tones(run([880, 1320], 0.06, { dur: 0.18, type: 'sine', gain: 0.25 })),
  buzz: tones([
    { freq: 196, dur: 0.38, type: 'sawtooth', gain: 0.22 },
    { freq: 294, dur: 0.38, type: 'square', gain: 0.1 },
  ]),
  // A die clattering to a stop: a few taps, each lower and quieter.
  dice: (c, out, t) => {
    for (const [at, from] of [[0, 2600], [0.11, 2200], [0.24, 1800], [0.4, 1400], [0.62, 1100]]) noise(c, out, t, { at, dur: 0.06, from, q: 3, gain: 0.3 });
  },
  correct: tones(run([659, 784, 988, 1319], 0.085, { dur: 0.32, type: 'triangle', gain: 0.26 })),
  wrong: tones([
    { freq: 155, to: 98, dur: 0.6, type: 'sawtooth', gain: 0.24 },
    { freq: 110, to: 73, dur: 0.6, type: 'square', gain: 0.1 },
  ]),
  timeup: tones(run([440, 440, 330], 0.2, { dur: 0.16, type: 'square', gain: 0.14 })),
  reveal: (c, out, t) => {
    noise(c, out, t, { dur: 0.35, from: 400, to: 5000, gain: 0.16 });
    tone(c, out, t, { freq: 587, at: 0.28, dur: 0.3, type: 'triangle', gain: 0.2 });
  },
  ding: tones([
    { freq: 1568, dur: 0.9, gain: 0.25 },
    { freq: 2349, dur: 0.6, gain: 0.1 },
  ]),
  strike: tones([
    { freq: 130, dur: 0.45, type: 'sawtooth', gain: 0.26 },
    { freq: 138, dur: 0.45, type: 'sawtooth', gain: 0.2 },
  ]),
  intro: tones([...run([392, 523, 659, 784], 0.11, { dur: 0.3, type: 'sawtooth', gain: 0.12 }), ...chord([523, 659, 784, 1047], { at: 0.46, dur: 0.9, type: 'triangle', gain: 0.14 })]),
  fanfare: tones([
    ...run([523, 523, 523, 659, 784], 0.13, { dur: 0.22, type: 'sawtooth', gain: 0.12 }),
    ...chord([523, 659, 784, 1047], { at: 0.72, dur: 1.4, type: 'triangle', gain: 0.16 }),
  ]),
  tick: tones([{ freq: 1000, dur: 0.04, type: 'square', gain: 0.06 }]),
  lock: tones(run([440, 587], 0.07, { dur: 0.12, type: 'triangle', gain: 0.2 })),
  // host-triggered cues
  applause: (c, out, t) => {
    noise(c, out, t, { dur: 2.6, from: 2200, q: 0.4, gain: 0.2, pulse: 17 });
    noise(c, out, t, { dur: 2.6, from: 900, q: 0.5, gain: 0.12, pulse: 11 });
  },
  drumroll: (c, out, t) => {
    noise(c, out, t, { dur: 2.2, from: 240, to: 420, q: 1.2, gain: 0.5, pulse: 26 });
    tone(c, out, t, { freq: 90, at: 2.2, dur: 0.5, type: 'triangle', gain: 0.4 });
    noise(c, out, t, { at: 2.2, dur: 0.7, from: 6000, q: 0.3, gain: 0.25 });
  },
  airhorn: tones([
    ...chord([466, 554, 698], { dur: 0.22, type: 'sawtooth', gain: 0.14 }),
    ...chord([466, 554, 698], { at: 0.28, dur: 0.22, type: 'sawtooth', gain: 0.14 }),
    ...chord([466, 554, 698], { at: 0.56, dur: 0.9, type: 'sawtooth', gain: 0.14 }),
  ]),
  sad: tones([
    { freq: 311, to: 293, dur: 0.38, type: 'sawtooth', gain: 0.14 },
    { freq: 293, to: 277, at: 0.4, dur: 0.38, type: 'sawtooth', gain: 0.14 },
    { freq: 277, to: 261, at: 0.8, dur: 0.38, type: 'sawtooth', gain: 0.14 },
    { freq: 261, to: 196, at: 1.2, dur: 1.1, type: 'sawtooth', gain: 0.16 },
  ]),
  tada: tones([...chord([523, 659, 784], { dur: 0.16, type: 'triangle', gain: 0.16 }), ...chord([587, 740, 880, 1175], { at: 0.2, dur: 1.1, type: 'triangle', gain: 0.16 })]),
  suspense: tones([
    { freq: 110, dur: 2.6, type: 'sawtooth', gain: 0.1 },
    { freq: 116.5, dur: 2.6, type: 'sawtooth', gain: 0.1 },
    { freq: 220, to: 233, dur: 2.6, type: 'triangle', gain: 0.08 },
  ]),
  confetti: tones(run([784, 988, 1175, 1568], 0.06, { dur: 0.3, type: 'triangle', gain: 0.18 })),
};

export function play(name: SoundName) {
  if (!ctx || !master || ctx.state !== 'running') return;
  RECIPES[name](ctx, master, ctx.currentTime + 0.01);
}

let hapticSwitch: HTMLLabelElement | null = null;

/**
 * iOS has no Vibration API, but Safari plays a light haptic tick whenever a
 * native switch control is toggled. Toggling a hidden one is the only haptic
 * available to a web page there; where it does nothing, nothing is lost.
 */
function switchTick() {
  if (!hapticSwitch) {
    hapticSwitch = document.createElement('label');
    hapticSwitch.setAttribute('aria-hidden', 'true');
    hapticSwitch.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.tabIndex = -1;
    input.setAttribute('switch', '');
    hapticSwitch.append(input);
    document.body.append(hapticSwitch);
  }
  hapticSwitch.click();
}

/** Physical feedback: a vibration pattern on Android, a single tick on iOS. */
export function haptic(pattern: number | number[]) {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    else switchTick();
  } catch {
    /* unsupported */
  }
}

/** The soundtrack of a game as heard on the shared screen. */
export function soundFor(event: GameEvent): SoundName | null {
  switch (event.type) {
    case 'player.joined': return 'join';
    case 'round.intro': return 'intro';
    case 'clue.selected': return event.wager ? 'tada' : 'select';
    case 'buzz.open': return 'open';
    case 'dice.rolled': return 'dice';
    case 'dice.tied': return 'timeup';
    case 'dice.won': return 'tada';
    case 'buzz.winner': return 'buzz';
    case 'judged': return event.correct ? 'correct' : 'wrong';
    case 'timeup': return 'timeup';
    case 'wager.locked': return 'lock';
    case 'fm.duplicate': return 'strike';
    case 'fm.reveal': return event.kind === 'answer' ? 'reveal' : event.points > 0 ? 'ding' : 'strike';
    case 'fm.result': return event.won ? 'fanfare' : 'sad';
    case 'final.stage': return 'reveal';
    case 'final.shown': return 'reveal';
    case 'game.finished': return 'fanfare';
    case 'cue': return event.name;
    default: return null;
  }
}
