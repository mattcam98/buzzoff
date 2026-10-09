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

/** Browsers only allow audio after a user gesture; call this from a click or tap. Resolves once sound can play. */
export function unlockAudio(): Promise<void> {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return Promise.resolve();
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  // Suspended until the first gesture. iOS also stops it ("interrupted") for a phone call or a spell
  // in the background, and it stays stopped until a later gesture starts it again.
  return ctx.state === 'running' ? Promise.resolve() : ctx.resume().catch(() => undefined);
}

export const audioReady = () => ctx?.state === 'running';

/** The shared context and output, for the music, which keeps its own time on the same clock. */
export const audioGraph = () => (ctx && master ? { ctx, out: master } : null);

interface Tone {
  freq: number;
  /** Glide to this frequency over the note. */
  to?: number;
  at?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  /** Seconds to reach full level. */
  attack?: number;
  /** Hold at full level and let go at the end, like a blown note. Without it a note dies away from the start, like a struck one. */
  hold?: boolean;
}

function tone(c: AudioContext, out: AudioNode, t0: number, n: Tone) {
  const start = t0 + (n.at ?? 0);
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = n.type ?? 'sine';
  osc.frequency.setValueAtTime(n.freq, start);
  if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, start + n.dur);
  const peak = n.gain ?? 0.3;
  const attack = n.attack ?? 0.012;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(peak, start + attack);
  if (n.hold) env.gain.setValueAtTime(peak, Math.max(start + attack, start + n.dur - Math.min(0.2, n.dur / 3)));
  env.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
  osc.connect(env).connect(out);
  osc.start(start);
  osc.stop(start + n.dur + 0.05);
}

function noise(c: AudioContext, out: AudioNode, t0: number, o: { at?: number; dur: number; gain?: number; from: number; to?: number; q?: number }) {
  const start = t0 + (o.at ?? 0);
  const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * o.dur), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
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

type Hit = [at: number, level: number];

/**
 * Noise made of separate hits, each a burst that dies away in `decay` seconds.
 * A few hundred scattered ones are a crowd clapping, a quick even stream is a
 * drum roll, and one long one is a cymbal.
 */
function bursts(c: AudioContext, out: AudioNode, t0: number, o: { hits: Hit[]; decay: number; from: number; q?: number; gain: number }) {
  const rate = c.sampleRate;
  const tail = Math.ceil(rate * o.decay * 7);
  const length = Math.ceil(rate * Math.max(...o.hits.map(([at]) => at))) + tail;
  const buffer = c.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (const [at, level] of o.hits) {
    const first = Math.floor(at * rate);
    for (let i = 0; i < tail; i++) data[first + i] += level * Math.exp(-i / (rate * o.decay));
  }
  for (let i = 0; i < length; i++) data[i] *= Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = o.from;
  filter.Q.value = o.q ?? 0.8;
  const level = c.createGain();
  level.gain.value = o.gain;
  src.connect(filter).connect(level).connect(out);
  src.start(t0);
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
  // Host-triggered cues. They play over the music, which is in C, so the tuned ones keep to that key.
  applause: (c, out, t) => {
    // A crowd is a few hundred separate claps: it erupts, then thins out as the room settles.
    const hits: Hit[] = [];
    for (let i = 0; i < 520; i++) {
      const when = Math.random() ** 1.35;
      hits.push([when * 3.2, (0.4 + 0.6 * Math.random()) * Math.min(1, (1 - when) * 2.5)]);
    }
    bursts(c, out, t, { hits, decay: 0.009, from: 1300, q: 0.9, gain: 0.21 });
    bursts(c, out, t, { hits, decay: 0.006, from: 2900, q: 0.7, gain: 0.125 });
  },
  drumroll: (c, out, t) => {
    // Sticks on a snare, a touch uneven, growing louder all the way into the hit.
    const roll = 2.2;
    const hits: Hit[] = [];
    for (let at = 0; at < roll; at += 0.033 + Math.random() * 0.006) hits.push([at, (0.3 + 0.7 * (at / roll) ** 1.5) * (0.8 + 0.2 * Math.random())]);
    bursts(c, out, t, { hits, decay: 0.014, from: 240, q: 1.2, gain: 0.9 });
    bursts(c, out, t, { hits, decay: 0.02, from: 3400, q: 0.5, gain: 0.3 });
    tone(c, out, t, { freq: 110, to: 55, at: roll, dur: 0.5, type: 'triangle', gain: 0.4 });
    bursts(c, out, t, { hits: [[roll, 1]], decay: 0.3, from: 6500, q: 0.3, gain: 0.5 });
  },
  // Two short blasts and a long one that sags as the air runs out.
  airhorn: tones([
    ...chord([392, 494, 587], { dur: 0.17, type: 'sawtooth', gain: 0.11, hold: true }),
    ...chord([392, 494, 587], { at: 0.24, dur: 0.17, type: 'sawtooth', gain: 0.11, hold: true }),
    ...[392, 494, 587].map((freq): Tone => ({ freq, to: freq * 0.94, at: 0.48, dur: 0.95, type: 'sawtooth', gain: 0.11, hold: true })),
  ]),
  // Wah, wah, wah, waaah: each note leans downhill and the last one slides off the stage.
  sad: tones(
    ([[311, 293, 0, 0.36], [293, 277, 0.4, 0.36], [277, 261, 0.8, 0.36], [261, 196, 1.2, 1.2]] as const).flatMap(([freq, to, at, dur]): Tone[] => [
      { freq, to, at, dur, type: 'sawtooth', gain: 0.12, hold: true, attack: 0.04 },
      { freq: freq / 2, to: to / 2, at, dur, type: 'triangle', gain: 0.1, hold: true, attack: 0.04 },
    ]),
  ),
  // "Ta" on the G chord, "da" on the C chord above it.
  tada: tones([...chord([392, 494, 587], { dur: 0.15, type: 'triangle', gain: 0.12, hold: true }), ...chord([523, 659, 784, 1047], { at: 0.19, dur: 1.2, type: 'triangle', gain: 0.09, hold: true })]),
  // A low, uneasy drone that holds while a higher note creeps up over it.
  suspense: tones([
    { freq: 110, dur: 2.8, type: 'sawtooth', gain: 0.07, hold: true, attack: 0.08 },
    { freq: 116.5, dur: 2.8, type: 'sawtooth', gain: 0.07, hold: true, attack: 0.08 },
    { freq: 220, to: 233, dur: 2.8, type: 'triangle', gain: 0.07, hold: true, attack: 0.08 },
    { freq: 440, to: 466, dur: 2.8, type: 'triangle', gain: 0.1, hold: true, attack: 2.3 },
  ]),
  // A sparkle running up the G chord, each note left to ring.
  confetti: tones(run([784, 988, 1175, 1568, 1976, 2349, 3136], 0.05, { dur: 0.7, type: 'triangle', gain: 0.13 })),
};

/** How many seconds the longer sounds last, so that the music can make room for exactly that long. */
export const LONG_SOUNDS: Partial<Record<SoundName, number>> = {
  intro: 1.4, fanfare: 2.2, applause: 3.3, drumroll: 3.4, airhorn: 1.5, sad: 2.4, tada: 1.4, suspense: 2.8, confetti: 0.9,
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
