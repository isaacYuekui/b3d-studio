// Synthesises the automatic soundtrack (core/sound.ts events) with the Web Audio API, offline:
// filtered noise and low sine sweeps shaped by envelopes — no samples to download, the same
// result every time for the same scene.

import type { SoundEvent } from '../core/sound';
import { levelAt } from '../core/sound';

export const SAMPLE_RATE = 48000;

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Ctx = OfflineAudioContext;

/** Two seconds of stereo noise: white (hiss) or brown (deep rumble). */
function noise(ctx: Ctx, kind: 'white' | 'brown', rnd: () => number): AudioBuffer {
  const len = SAMPLE_RATE * 2;
  const buf = ctx.createBuffer(2, len, SAMPLE_RATE);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = rnd() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
  }
  return buf;
}

/** Follow an event's loudness on a gain parameter (sampled every 50 ms), times `scale`. */
function follow(param: AudioParam, e: SoundEvent, scale: number, fade = 0.08) {
  param.setValueAtTime(0, Math.max(0, e.start));
  const step = 0.05;
  for (let t = e.start; t <= e.end; t += step) param.linearRampToValueAtTime(levelAt(e, t) * scale, Math.max(0, t) + (t === e.start ? fade : 0));
  param.linearRampToValueAtTime(0, e.end + fade);
}

export async function renderSoundtrack(events: SoundEvent[], duration: number, seed = 7): Promise<AudioBuffer | null> {
  const Off = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!events.length || !Off) return null;
  const ctx = new Off(2, Math.max(1, Math.ceil(duration * SAMPLE_RATE)), SAMPLE_RATE);
  const rnd = rng(seed);
  const white = noise(ctx, 'white', rnd);
  const brown = noise(ctx, 'brown', rnd);

  // Master: a compressor keeps a big explosion from clipping and lifts the quieter layers.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 3;
  comp.attack.value = 0.004;
  comp.release.value = 0.3;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  comp.connect(master).connect(ctx.destination);

  const src = (buf: AudioBuffer, start: number, end: number) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(Math.max(0, start), rnd() * 1.9);
    s.stop(Math.max(0, end) + 0.2);
    return s;
  };
  const filter = (type: BiquadFilterType, freq: number, q = 0.7) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  };
  const gain = (v = 0) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  /** A decaying hit: instant attack to `peak`, exponential fall over `decay` seconds. */
  const hit = (param: AudioParam, at: number, peak: number, decay: number, attack = 0.006) => {
    param.setValueAtTime(0.0001, Math.max(0, at));
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), Math.max(0, at) + attack);
    param.exponentialRampToValueAtTime(0.0001, Math.max(0, at) + attack + decay);
  };
  let clicks = 0;
  const click = (at: number, amp: number, freq: number, len: number, buf = white) => {
    if (clicks++ > 4000 || at < 0 || at > duration) return;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const f = filter('bandpass', freq, 1.2);
    const g = gain();
    hit(g.gain, at, amp, len, 0.002);
    s.connect(f).connect(g).connect(comp);
    s.start(at, rnd() * 1.9);
    s.stop(at + len + 0.05);
  };

  for (const e of events) {
    const g = e.gain;
    switch (e.kind) {
      case 'boom': {
        const t = e.start;
        // Sub-bass thump sweeping down.
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(62, Math.max(0, t));
        osc.frequency.exponentialRampToValueAtTime(26, Math.max(0, t) + 1.6);
        const og = gain();
        hit(og.gain, t, 1.8 * g, 2.4, 0.01);
        osc.connect(og).connect(comp);
        osc.start(Math.max(0, t));
        osc.stop(Math.max(0, t) + 3);
        // The blast body: deep noise closing down.
        const lp = filter('lowpass', 1200);
        lp.frequency.setValueAtTime(1400, Math.max(0, t));
        lp.frequency.exponentialRampToValueAtTime(140, Math.max(0, t) + 2.5);
        const bg = gain();
        hit(bg.gain, t, 2.2 * g, 3.2);
        src(brown, t, t + 4).connect(lp).connect(bg).connect(comp);
        // The crack at the start.
        const hp = filter('highpass', 900);
        const cg = gain();
        hit(cg.gain, t, 0.7 * g, 0.14, 0.002);
        src(white, t, t + 0.4).connect(hp).connect(cg).connect(comp);
        // Long low tail.
        const tl = filter('lowpass', 180);
        const tg = gain();
        tg.gain.setValueAtTime(0, Math.max(0, t));
        tg.gain.linearRampToValueAtTime(0.55 * g, Math.max(0, t) + 0.3);
        tg.gain.linearRampToValueAtTime(0, Math.min(e.end, t + 5));
        src(brown, t, e.end).connect(tl).connect(tg).connect(comp);
        // Bits landing a moment later.
        for (let k = 0; k < 40 * g; k++) click(t + 0.4 + rnd() * 2.2, (0.15 + 0.25 * rnd()) * g, 600 + rnd() * 2500, 0.03 + rnd() * 0.08);
        break;
      }
      case 'rumble': {
        const lp = filter('lowpass', 110);
        const gg = gain();
        follow(gg.gain, e, 1.4);
        src(brown, e.start, e.end).connect(lp).connect(gg).connect(comp);
        break;
      }
      case 'roar': {
        const lp = filter('lowpass', 650);
        const gg = gain();
        follow(gg.gain, e, 1.3);
        src(brown, e.start, e.end).connect(lp).connect(gg).connect(comp);
        const bp = filter('bandpass', 2400, 0.6);
        const hg = gain();
        follow(hg.gain, e, 0.35);
        src(white, e.start, e.end).connect(bp).connect(hg).connect(comp);
        break;
      }
      case 'crackle': {
        const lp = filter('lowpass', 380);
        const gg = gain();
        follow(gg.gain, e, 0.5, 0.4);
        src(brown, e.start, e.end).connect(lp).connect(gg).connect(comp);
        for (let t = Math.max(0, e.start); t < e.end; t += 1 / (18 + 30 * g)) click(t + rnd() * 0.04, (0.05 + 0.2 * rnd() ** 3) * levelAt(e, t), 1500 + rnd() * 4000, 0.004 + rnd() * 0.012);
        break;
      }
      case 'whoosh': {
        const bp = filter('bandpass', 400, 1.1);
        // Pitch rises with loudness (closer = higher, like a passing jet).
        bp.frequency.setValueAtTime(300, Math.max(0, e.start));
        for (let t = e.start; t <= e.end; t += 0.1) bp.frequency.linearRampToValueAtTime(300 + 1800 * (levelAt(e, t) / Math.max(0.01, e.gain)), Math.max(0, t));
        const gg = gain();
        follow(gg.gain, e, 1.1);
        src(white, e.start, e.end).connect(bp).connect(gg).connect(comp);
        const lp = filter('lowpass', 260);
        const lg = gain();
        follow(lg.gain, e, 0.8);
        src(brown, e.start, e.end).connect(lp).connect(lg).connect(comp);
        break;
      }
      case 'rain': {
        const hp = filter('highpass', 1800);
        const lp = filter('lowpass', 9000);
        const gg = gain();
        follow(gg.gain, e, 0.45, 0.6);
        src(white, e.start, e.end).connect(hp).connect(lp).connect(gg).connect(comp);
        break;
      }
      case 'wind': {
        const bp = filter('bandpass', 420, 2.5);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.13 + rnd() * 0.1;
        const depth = gain(220);
        lfo.connect(depth).connect(bp.frequency);
        lfo.start(Math.max(0, e.start));
        lfo.stop(e.end + 0.2);
        const gg = gain();
        follow(gg.gain, e, 0.7, 0.8);
        src(white, e.start, e.end).connect(bp).connect(gg).connect(comp);
        break;
      }
      case 'debris': {
        // Crashes: short bursts where the pieces hit, more and louder the harder they land.
        const env = e.env ?? [];
        for (let i = 0; i < env.length; i++) {
          const [t, v] = env[i];
          if (v < 0.04) continue;
          const n = Math.min(5, Math.round(v * 6 * rnd() + v * 2));
          for (let k = 0; k < n; k++) click(t + rnd() / 24, v * g * (0.25 + 0.6 * rnd()), 250 + rnd() * 2200, 0.04 + rnd() * 0.18, rnd() < 0.6 ? brown : white);
        }
        const bp = filter('bandpass', 500, 0.6);
        const gg = gain();
        follow(gg.gain, e, 0.6, 0.05);
        src(brown, e.start, e.end).connect(bp).connect(gg).connect(comp);
        break;
      }
      case 'sea': {
        const lp = filter('lowpass', 520);
        const gg = gain();
        // Waves come and go every few seconds.
        gg.gain.setValueAtTime(0, Math.max(0, e.start));
        for (let t = e.start; t <= e.end; t += 0.25) gg.gain.linearRampToValueAtTime(g * 0.45 * (0.55 + 0.45 * Math.sin((t / 6.5) * Math.PI * 2) ** 2) * Math.min(1, (t - e.start) / 1.5), Math.max(0, t));
        src(brown, e.start, e.end).connect(lp).connect(gg).connect(comp);
        const bp = filter('bandpass', 1300, 0.5);
        const hg = gain(g * 0.08);
        src(white, e.start, e.end).connect(bp).connect(hg).connect(comp);
        break;
      }
    }
  }
  return ctx.startRendering();
}

/** 16-bit PCM WAV of a buffer (for editing apps that want the sound on its own). */
export function encodeWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels, len = buf.length, rate = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + len * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * ch * 2, true);
  data.setUint16(32, ch * 2, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, len * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  return new Blob([data.buffer], { type: 'audio/wav' });
}
