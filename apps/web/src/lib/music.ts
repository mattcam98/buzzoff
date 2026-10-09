/**
 * The background music on the shared screen. Like every other sound in BuzzOff
 * it is synthesised, so there are no audio files and nothing to license: the
 * tunes below are BuzzOff's own, written out as note lists, and a small
 * sequencer plays them against the Web Audio clock.
 *
 * The music follows the game. The theme plays in the lobby and between rounds,
 * thins out to a backing while a clue is being chosen, gives way to a quiet
 * pulse while a question is live, and stops altogether whenever someone is
 * answering or an answer is being revealed.
 */
import type { PublicView } from '@buzzoff/shared';
import { audioGraph, LONG_SOUNDS, type SoundName } from './sound';

export type Mood = 'theme' | 'bed' | 'think' | 'tension';

// ---------------------------------------------------------------- notation

interface Note {
  /** Position and length in eighth notes. */
  step: number;
  steps: number;
  freqs: number[];
}

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C#4" as a frequency in hertz. */
function hz(name: string): number {
  const m = /^([A-G])([#b]?)(\d)$/.exec(name);
  if (!m) throw new Error(`Not a note: ${name}`);
  const midi = SEMITONES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Bars of music, one string each, in eighth notes: "C4:2 E4+G4 -:3 x:2" is
 * a C for two steps, a chord for one, three steps of rest and a drum hit.
 */
function line(...bars: string[]): Note[] {
  const notes: Note[] = [];
  let step = 0;
  for (const bar of bars) {
    for (const token of bar.trim().split(/\s+/)) {
      const [pitch, length = '1'] = token.split(':');
      const steps = Number(length);
      if (pitch !== '-') notes.push({ step, steps, freqs: pitch === 'x' ? [0] : pitch.split('+').map(hz) });
      step += steps;
    }
    // Every bar is four beats. A miscounted one would drag the whole part out of time, so it fails loudly instead.
    if (step % 8) throw new Error(`Not a full bar: ${bar}`);
  }
  return notes;
}

// ---------------------------------------------------------------- instruments

interface Patch {
  type: OscillatorType;
  /** Low-pass cutoff in hertz, to take the edge off a bright wave. */
  cutoff?: number;
  attack?: number;
  /** Ring out over this many seconds instead of holding for the note's length. */
  decay?: number;
  /** Frequency multiplier, for overtones. */
  ratio?: number;
}

function osc(c: BaseAudioContext, out: AudioNode, t: number, dur: number, freq: number, gain: number, p: Patch) {
  const source = c.createOscillator();
  const env = c.createGain();
  const attack = p.attack ?? 0.008;
  const end = t + (p.decay ?? dur);
  source.type = p.type;
  source.frequency.value = freq * (p.ratio ?? 1);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + attack);
  if (!p.decay) env.gain.setValueAtTime(gain, Math.max(t + attack, end - 0.04));
  env.gain.exponentialRampToValueAtTime(0.0001, end);
  let node: AudioNode = source;
  if (p.cutoff) {
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    node = source.connect(filter);
  }
  node.connect(env).connect(out);
  source.start(t);
  source.stop(end + 0.05);
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

function noise(c: BaseAudioContext, out: AudioNode, t: number, dur: number, gain: number, type: BiquadFilterType, freq: number) {
  let buffer = noiseBuffers.get(c);
  if (!buffer) {
    buffer = c.createBuffer(1, c.sampleRate / 2, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffers.set(c, buffer);
  }
  const source = c.createBufferSource();
  const filter = c.createBiquadFilter();
  const env = c.createGain();
  source.buffer = buffer;
  filter.type = type;
  filter.frequency.value = freq;
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  source.connect(filter).connect(env).connect(out);
  source.start(t);
  source.stop(t + dur + 0.02);
}

type Voice = (c: BaseAudioContext, out: AudioNode, t: number, dur: number, freq: number, gain: number) => void;

const VOICES = {
  // A bright, brassy lead with a softer octave underneath it.
  lead: (c, out, t, dur, freq, gain) => {
    osc(c, out, t, dur, freq, gain, { type: 'sawtooth', cutoff: 2400, attack: 0.02 });
    osc(c, out, t, dur, freq, gain * 0.5, { type: 'triangle', ratio: 0.5, attack: 0.02 });
  },
  // Short horn-section stabs.
  stab: (c, out, t, dur, freq, gain) => osc(c, out, t, Math.min(dur, 0.16), freq, gain, { type: 'sawtooth', cutoff: 1700 }),
  // The octave on top is what a small TV speaker actually reproduces.
  bass: (c, out, t, dur, freq, gain) => {
    osc(c, out, t, dur, freq, gain, { type: 'triangle', cutoff: 900 });
    osc(c, out, t, dur, freq, gain * 0.45, { type: 'sine', ratio: 2 });
  },
  // A marimba-like pluck: a quick knock and a rounder tone that rings on.
  pluck: (c, out, t, _dur, freq, gain) => {
    osc(c, out, t, 0, freq, gain, { type: 'sine', decay: 0.5, attack: 0.004 });
    osc(c, out, t, 0, freq, gain * 0.3, { type: 'sine', ratio: 4, decay: 0.09, attack: 0.002 });
  },
  // A music-box bell for slow melodies.
  bell: (c, out, t, dur, freq, gain) => {
    osc(c, out, t, 0, freq, gain, { type: 'triangle', decay: Math.max(0.6, dur * 1.3), attack: 0.005 });
    osc(c, out, t, 0, freq, gain * 0.2, { type: 'sine', ratio: 3, decay: 0.3, attack: 0.003 });
  },
  kick: (c, out, t, _dur, _freq, gain) => {
    const source = c.createOscillator();
    const env = c.createGain();
    source.frequency.setValueAtTime(130, t);
    source.frequency.exponentialRampToValueAtTime(48, t + 0.11);
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    source.connect(env).connect(out);
    source.start(t);
    source.stop(t + 0.2);
  },
  snare: (c, out, t, _dur, _freq, gain) => {
    noise(c, out, t, 0.11, gain, 'bandpass', 1900);
    osc(c, out, t, 0, 190, gain * 0.5, { type: 'triangle', decay: 0.07, attack: 0.002 });
  },
  hat: (c, out, t, _dur, _freq, gain) => noise(c, out, t, 0.035, gain, 'highpass', 7000),
  // A clock: tick, then a lower tock.
  tick: (c, out, t, _dur, _freq, gain) => osc(c, out, t, 0, 1250, gain, { type: 'sine', decay: 0.05, attack: 0.002 }),
  tock: (c, out, t, _dur, _freq, gain) => osc(c, out, t, 0, 880, gain, { type: 'sine', decay: 0.06, attack: 0.002 }),
} satisfies Record<string, Voice>;

// ---------------------------------------------------------------- the tunes

interface Part {
  voice: keyof typeof VOICES;
  gain: number;
  notes: Note[];
}

interface Song {
  bpm: number;
  /** Where the off-beat eighth falls within a beat: 0.5 is straight, two thirds is a shuffle. */
  offbeat: number;
  /** Length of the loop in eighth notes. */
  steps: number;
  parts: Record<string, Part>;
}

const every = (bars: number, bar: string) => Array.from({ length: bars }, () => bar);

// Shared chord voicings, kept in the middle of the keyboard.
const C6 = 'E4+G4+A4+C5';
const A7 = 'E4+G4+A4+C#5';
const Dm7 = 'F4+A4+C5+D5';
const G7 = 'F4+G4+B4+D5';
const Fsdim = 'F#4+A4+C5+Eb5';
const CoverG = 'G4+A4+C5+E5';
/** Two off-beat stabs in a bar, the way a horn section answers a melody. */
const comp = (first: string, second = first) => `-:3 ${first} -:2 ${second} -`;

const SONGS = {
  /**
   * The BuzzOff theme: a sixteen-bar shuffle in C, the key the fanfares and
   * stings are already in. Eight bars of tune over a walking bass, then an
   * eight-bar answer that starts on the F chord and walks back home.
   */
  theme: {
    bpm: 132,
    offbeat: 2 / 3,
    steps: 128,
    parts: {
      lead: {
        voice: 'lead',
        gain: 0.085,
        notes: line(
          'G4 C5 E5:2 - E5 G5:2',
          'A5:3 G5 E5:2 C#5:2',
          'D5 F5 A5:2 - A5 C6:2',
          'B5:3 A5 G5:2 F5 D5',
          'E5 G5 C6:2 - C6 A5:2',
          'G5:2 E5 C#5 E5:2 A4:2',
          'D5 E5 F5 A5 G5 B5 D6:2',
          'C6:3 - G5 E5 C5:2',
          'A5:2 C6 A5 F5:2 -:2',
          'A5:2 C6 A5 Eb5:2 -:2',
          'G5:2 C6 G5 E5:2 -:2',
          'G5 E5 C#5 E5 A5:4',
          'F5 A5 D6:2 C6 A5 F5:2',
          'G5 B5 D6:2 B5 G5 F5:2',
          'E5:2 G5:2 C6:3 -',
          '-:2 G5 F5 D5 B4 -:2',
        ),
      },
      comp: {
        voice: 'stab',
        gain: 0.03,
        notes: line(
          comp(C6), comp(A7), comp(Dm7), comp(G7), comp(C6), comp(A7), comp(Dm7, G7), comp(C6, G7),
          comp(Dm7), comp(Fsdim), comp(CoverG), comp(A7), comp(Dm7), comp(G7), comp(C6), comp(G7),
        ),
      },
      bass: {
        voice: 'bass',
        gain: 0.13,
        notes: line(
          'C2:2 E2:2 G2:2 A2:2',
          'A2:2 C#3:2 E3:2 C#3:2',
          'D2:2 F2:2 A2:2 C3:2',
          'G2:2 B2:2 D3:2 B2:2',
          'C2:2 E2:2 G2:2 A2:2',
          'A2:2 G2:2 E2:2 C#2:2',
          'D2:2 F2:2 G2:2 B2:2',
          'C3:2 G2:2 C2:2 G2:2',
          'F2:2 A2:2 C3:2 A2:2',
          'F#2:2 A2:2 C3:2 Eb3:2',
          'G2:2 C3:2 E3:2 C3:2',
          'A2:2 G2:2 E2:2 C#2:2',
          'D2:2 F2:2 A2:2 C3:2',
          'G2:2 B2:2 D3:2 F3:2',
          'C3:2 E3:2 G3:2 E3:2',
          'G2:2 F2:2 E2:2 D2:2',
        ),
      },
      // The ride pattern of a shuffle: ding, ding-a-ding.
      hat: { voice: 'hat', gain: 0.05, notes: line(...every(16, 'x:2 x x x:2 x x')) },
      kick: { voice: 'kick', gain: 0.16, notes: line(...every(16, 'x:4 x:4')) },
      snare: { voice: 'snare', gain: 0.07, notes: line(...every(16, '-:2 x:4 x:2')) },
    },
  },

  /**
   * Thinking music for the written final: a music box over a ticking clock,
   * in A minor so that it sits apart from the theme without clashing with it.
   */
  think: {
    bpm: 100,
    offbeat: 0.5,
    steps: 64,
    parts: {
      melody: {
        voice: 'bell',
        gain: 0.085,
        notes: line(
          'C6:3 B5 A5:4',
          'A5:3 G5 F5:4',
          'G5:3 A5 G5:2 E5:2',
          'D5:6 -:2',
          'C6:3 B5 A5:2 E6:2',
          'D6:3 C6 A5:4',
          'F5:2 A5:2 D6:2 F6:2',
          'E6:4 -:2 G#5 B5',
        ),
      },
      arp: {
        voice: 'pluck',
        gain: 0.06,
        notes: line(
          'A3 E4 A4 C5 E5 C5 A4 E4',
          'F3 C4 F4 A4 C5 A4 F4 C4',
          'C4 G4 C5 E5 G5 E5 C5 G4',
          'G3 D4 G4 B4 D5 B4 G4 D4',
          'A3 E4 A4 C5 E5 C5 A4 E4',
          'F3 C4 F4 A4 C5 A4 F4 C4',
          'D4 A4 D5 F5 A5 F5 D5 A4',
          'E4 G#4 B4 D5 E5 D5 B4 G#4',
        ),
      },
      bass: {
        voice: 'bass',
        gain: 0.1,
        notes: line('A2:4 A2:4', 'F2:4 F2:4', 'C3:4 C3:4', 'G2:4 G2:4', 'A2:4 A2:4', 'F2:4 F2:4', 'D3:4 D3:4', 'E2:4 E2:4'),
      },
      tick: { voice: 'tick', gain: 0.07, notes: line(...every(8, 'x:4 x:4')) },
      tock: { voice: 'tock', gain: 0.07, notes: line(...every(8, '-:2 x:4 x:2')) },
    },
  },

  /** A pulse for when a question is live: quiet enough to read a clue over, steady enough to feel the clock. */
  tension: {
    bpm: 112,
    offbeat: 0.5,
    steps: 32,
    parts: {
      bass: {
        voice: 'bass',
        gain: 0.1,
        notes: line(...every(2, 'A2 A2 A2 A2 A2 A2 A2 A2'), 'F2 F2 F2 F2 F2 F2 F2 F2', 'G2 G2 G2 G2 E2 E2 E2 E2'),
      },
      arp: {
        voice: 'pluck',
        gain: 0.045,
        notes: line(...every(2, 'A4 - C5 - E5 - C5 -'), 'A4 - C5 - F5 - C5 -', 'B4 - D5 - G#4 - B4 -'),
      },
      hat: { voice: 'hat', gain: 0.03, notes: line(...every(4, '- x - x - x - x')) },
    },
  },
} satisfies Record<string, Song>;

/** Which tune each mood plays, how loud, and with which instruments (all of them unless listed). */
const MOODS: Record<Mood, { song: keyof typeof SONGS; level: number; parts?: string[] }> = {
  theme: { song: 'theme', level: 1 },
  // The theme with the tune taken out, to talk over while a clue is chosen.
  bed: { song: 'theme', level: 0.6, parts: ['bass', 'comp', 'hat'] },
  think: { song: 'think', level: 1.25 },
  tension: { song: 'tension', level: 0.7 },
};

/** What the room should be hearing at this point in the game, or null for silence. */
export function moodFor(pub: PublicView): Mood | null {
  if (!pub.music || pub.paused) return null;
  if (pub.phase !== 'round') return 'theme';
  const round = pub.round;
  if (!round) return null;
  if (round.stage === 'intro') return 'theme';
  // A clue with its own sound or video is never played over.
  const hasSound = (media: { kind: string } | null) => media !== null && media.kind !== 'image';
  switch (round.mode) {
    case 'trivia': {
      const clue = round.clue;
      if (round.stage !== 'clue' || !clue) return 'bed';
      // Silence once somebody has buzzed in, and while the answer is on screen.
      return (clue.stage === 'open' || clue.stage === 'wager') && !hasSound(clue.media) ? 'tension' : null;
    }
    case 'final':
      if (round.stage === 'wager') return 'tension';
      return round.stage === 'answering' && !hasSound(round.media) ? 'think' : null;
    case 'fastMoney':
      if (round.stage === 'ready') return 'bed';
      return round.stage === 'answering' ? 'tension' : null;
  }
}

// ---------------------------------------------------------------- sequencer

interface Scheduled {
  /** Seconds from the start of the loop. */
  at: number;
  dur: number;
  part: string;
  freqs: number[];
}

/** A song's notes in the order they sound, timed in seconds. */
function timeline(song: Song): { events: Scheduled[]; length: number } {
  const beat = 60 / song.bpm;
  const timeOf = (step: number) => (Math.floor(step / 2) + (step % 2 ? song.offbeat : 0)) * beat;
  const events = Object.entries(song.parts)
    .flatMap(([part, p]) => p.notes.map((n) => ({ at: timeOf(n.step), dur: (timeOf(n.step + n.steps) - timeOf(n.step)) * 0.92, part, freqs: n.freqs })))
    .sort((a, b) => a.at - b.at);
  return { events, length: timeOf(song.steps) };
}

/** Sound one event of a song at an absolute time. */
function sound(c: BaseAudioContext, outs: Record<string, AudioNode>, song: Song, event: Scheduled, t: number) {
  const part = song.parts[event.part];
  for (const freq of event.freqs) (VOICES[part.voice] as Voice)(c, outs[event.part], t, event.dur, freq, part.gain);
}

/** How loud music is next to the sound effects, which share its output. */
const MUSIC_LEVEL = 0.5;
/** How far ahead of the clock notes are committed, and how often the queue is topped up. */
const LOOKAHEAD = 0.25;
const TICK_MS = 50;

interface Playing {
  song: Song;
  events: Scheduled[];
  length: number;
  bus: GainNode;
  parts: Record<string, GainNode>;
  /** The audio-clock time the current pass of the loop began, once it has. */
  loopStart: number | null;
  cursor: number;
}

let mood: Mood | null = null;
let playing: Playing | null = null;
let musicBus: GainNode | null = null;
let timer: number | undefined;

function pump() {
  const graph = audioGraph();
  if (!graph || !playing || graph.ctx.state !== 'running') return;
  const now = graph.ctx.currentTime;
  playing.loopStart ??= now + 0.06;
  for (;;) {
    const event = playing.events[playing.cursor];
    const t = playing.loopStart + event.at;
    if (t > now + LOOKAHEAD) return;
    // A note the clock has already passed (a throttled background tab) is dropped rather than played late.
    if (t >= now) sound(graph.ctx, playing.parts, playing.song, event, t);
    if (++playing.cursor === playing.events.length) {
      playing.cursor = 0;
      playing.loopStart += playing.length;
    }
  }
}

function stop(now: number) {
  if (!playing) return;
  const { bus } = playing;
  bus.gain.cancelScheduledValues(now);
  bus.gain.setTargetAtTime(0, now, 0.12);
  window.setTimeout(() => bus.disconnect(), 1500);
  playing = null;
}

/** Play the music for a mood, or none. Changing between moods of the same tune never restarts it. */
export function setMusic(next: Mood | null) {
  const graph = audioGraph();
  // Nothing can play until the screen has been clicked once; the caller asks again when it has.
  if (!graph) next = null;
  if (next === mood) return;
  mood = next;
  if (!graph) return;
  const { ctx, out } = graph;
  const now = ctx.currentTime;
  const target = next ? MOODS[next] : null;
  if (playing && (!target || SONGS[target.song] !== playing.song)) stop(now);
  if (!target) {
    window.clearInterval(timer);
    timer = undefined;
    return;
  }
  if (!musicBus) {
    musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_LEVEL;
    musicBus.connect(out);
  }
  if (!playing) {
    const song: Song = SONGS[target.song];
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(musicBus);
    const parts: Record<string, GainNode> = {};
    for (const name of Object.keys(song.parts)) {
      parts[name] = ctx.createGain();
      parts[name].gain.value = !target.parts || target.parts.includes(name) ? 1 : 0;
      parts[name].connect(bus);
    }
    playing = { song, ...timeline(song), bus, parts, loopStart: null, cursor: 0 };
  }
  for (const [name, node] of Object.entries(playing.parts)) node.gain.setTargetAtTime(!target.parts || target.parts.includes(name) ? 1 : 0, now, 0.15);
  playing.bus.gain.setTargetAtTime(target.level, now, 0.15);
  timer ??= window.setInterval(pump, TICK_MS);
  pump();
}

/** How much of the music is left under a fanfare or one of the host's sound effects: enough to know it is still there. */
const DUCKED = 0.12;

/** Pull the music right back for as long as a fanfare or one of the host's sound effects lasts. */
export function duckMusic(effect: SoundName) {
  const graph = audioGraph();
  const seconds = LONG_SOUNDS[effect];
  if (!graph || !musicBus || !seconds) return;
  const now = graph.ctx.currentTime;
  musicBus.gain.cancelScheduledValues(now);
  musicBus.gain.setTargetAtTime(MUSIC_LEVEL * DUCKED, now, 0.03);
  musicBus.gain.setTargetAtTime(MUSIC_LEVEL, now + seconds, 0.3);
}
