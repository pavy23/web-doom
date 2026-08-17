// Repository-owned OPL2/AdLib-style music engine for the direct LinuxDOOM port.
//
// It reads DOOM's GENMIDI lump from the preloaded IWAD, parses the original
// MUS event stream, and recreates the GENMIDI 2-operator instruments with
// WebAudio FM graphs. This is intentionally an OPL2-style reconstruction,
// not a cycle-accurate YM3812 chip emulator.

(() => {
  'use strict';

  const OPL_VOICE_LIMIT = 9;
  const GENMIDI_HEADER = '#OPL_II#';
  const GENMIDI_MAIN = 128;
  const GENMIDI_PERC = 47;
  const GENMIDI_INSTR_SIZE = 36;
  const FLAG_FIXED = 0x0001;
  const FLAG_2VOICE = 0x0004;
  const MULTIPLIER = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];

  let current = null;
  let cachedBank = null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ascii = (bytes, start, len) => {
    let s = '';
    for (let i = 0; i < len; ++i) {
      const c = bytes[start + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  function audioContext() {
    if (typeof SDL2 !== 'undefined' && SDL2.audioContext) return SDL2.audioContext;
    if (globalThis.__doomMusicContext) return globalThis.__doomMusicContext;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    globalThis.__doomMusicContext = new Ctor();
    return globalThis.__doomMusicContext;
  }

  function findWadLump(wad, wantedName) {
    const view = new DataView(wad.buffer, wad.byteOffset, wad.byteLength);
    if (wad.length < 12) return null;
    const count = view.getUint32(4, true);
    const dir = view.getUint32(8, true);
    if (dir + count * 16 > wad.length) return null;

    const wanted = wantedName.toUpperCase();
    for (let i = 0; i < count; ++i) {
      const e = dir + i * 16;
      const pos = view.getUint32(e, true);
      const size = view.getUint32(e + 4, true);
      const name = ascii(wad, e + 8, 8).toUpperCase();
      if (name === wanted && pos + size <= wad.length) {
        return wad.slice(pos, pos + size);
      }
    }
    return null;
  }

  function parseOperator(bytes, o) {
    return {
      flags: bytes[o],
      attackDecay: bytes[o + 1],
      sustainRelease: bytes[o + 2],
      waveform: bytes[o + 3] & 7,
      scale: bytes[o + 4],
      level: bytes[o + 5] & 0x3f
    };
  }

  function parseVoice(bytes, o, view) {
    return {
      mod: parseOperator(bytes, o),
      feedback: bytes[o + 6],
      car: parseOperator(bytes, o + 7),
      baseNoteOffset: view.getInt16(o + 14, true)
    };
  }

  function parseInstrument(bytes, o, view) {
    return {
      flags: view.getUint16(o, true),
      fineTuning: bytes[o + 2],
      fixedNote: bytes[o + 3],
      voices: [parseVoice(bytes, o + 4, view), parseVoice(bytes, o + 20, view)]
    };
  }

  function fallbackInstrument() {
    const op = { flags: 0x01, attackDecay: 0xf3, sustainRelease: 0x74, waveform: 0, scale: 0, level: 8 };
    const mod = { flags: 0x01, attackDecay: 0xd4, sustainRelease: 0x75, waveform: 0, scale: 0, level: 20 };
    return {
      flags: 0,
      fineTuning: 128,
      fixedNote: 60,
      voices: [
        { mod, feedback: 0x04, car: op, baseNoteOffset: 0 },
        { mod, feedback: 0x04, car: op, baseNoteOffset: 0 }
      ]
    };
  }

  function loadBank() {
    if (cachedBank) return cachedBank;

    try {
      if (!globalThis.Module || !Module.FS) throw new Error('Emscripten FS is unavailable');
      let wad;
      try { wad = Module.FS.readFile('/doom1.wad'); }
      catch (_) { wad = Module.FS.readFile('doom1.wad'); }

      const lump = findWadLump(wad, 'GENMIDI');
      if (!lump) throw new Error('GENMIDI lump not found');
      if (ascii(lump, 0, 8) !== GENMIDI_HEADER) throw new Error('Unexpected GENMIDI header');

      const minimum = 8 + (GENMIDI_MAIN + GENMIDI_PERC) * GENMIDI_INSTR_SIZE;
      if (lump.length < minimum) throw new Error('GENMIDI lump is truncated');

      const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
      const main = [];
      const percussion = [];
      let o = 8;
      for (let i = 0; i < GENMIDI_MAIN; ++i, o += GENMIDI_INSTR_SIZE)
        main.push(parseInstrument(lump, o, view));
      for (let i = 0; i < GENMIDI_PERC; ++i, o += GENMIDI_INSTR_SIZE)
        percussion.push(parseInstrument(lump, o, view));

      cachedBank = { main, percussion, source: 'GENMIDI' };
      console.log('DOOM OPL: loaded GENMIDI bank', main.length, 'melodic +', percussion.length, 'percussion');
      return cachedBank;
    } catch (err) {
      console.error('DOOM OPL: GENMIDI load failed, using fallback FM patch:', err);
      const f = fallbackInstrument();
      cachedBank = {
        main: Array.from({ length: GENMIDI_MAIN }, () => f),
        percussion: Array.from({ length: GENMIDI_PERC }, () => f),
        source: 'fallback'
      };
      return cachedBank;
    }
  }

  function parseMus(bytes) {
    const u16 = o => bytes[o] | (bytes[o + 1] << 8);
    if (bytes.length < 16 || ascii(bytes, 0, 4) !== 'MUS\x1a')
      throw new Error('Invalid MUS header');

    const scoreLen = u16(4);
    const scoreStart = u16(6);
    const scoreEnd = Math.min(bytes.length, scoreStart + scoreLen);
    const events = [];
    let pos = scoreStart;
    let tick = 0;

    while (pos < scoreEnd) {
      const descriptor = bytes[pos++];
      const last = (descriptor & 0x80) !== 0;
      const type = (descriptor >> 4) & 7;
      const ch = descriptor & 15;
      const e = { tick, type, ch };

      if (type === 0) {
        if (pos >= scoreEnd) break;
        e.note = bytes[pos++] & 127;
        events.push(e);
      } else if (type === 1) {
        if (pos >= scoreEnd) break;
        const n = bytes[pos++];
        e.note = n & 127;
        e.hasVelocity = (n & 0x80) !== 0;
        if (e.hasVelocity) {
          if (pos >= scoreEnd) break;
          e.velocity = bytes[pos++] & 127;
        }
        events.push(e);
      } else if (type === 2) {
        if (pos >= scoreEnd) break;
        e.pitch = bytes[pos++];
        events.push(e);
      } else if (type === 3) {
        if (pos >= scoreEnd) break;
        e.ctrl = bytes[pos++] & 127;
        events.push(e);
      } else if (type === 4) {
        if (pos + 1 >= scoreEnd) break;
        e.ctrl = bytes[pos++] & 127;
        e.value = bytes[pos++] & 127;
        events.push(e);
      } else if (type === 6) {
        events.push(e);
        break;
      } else {
        break;
      }

      if (last && type !== 6) {
        let delay = 0;
        let b;
        do {
          if (pos >= scoreEnd) break;
          b = bytes[pos++];
          delay = (delay << 7) | (b & 127);
        } while (b & 0x80);
        tick += delay;
      }
    }

    return { events, duration: Math.max(0.25, tick / 140 + 0.15) };
  }

  function rateTime(rate, slow, fast) {
    if (rate <= 0) return slow;
    const x = clamp(rate, 0, 15) / 15;
    return slow * Math.pow(fast / slow, x);
  }

  function envelope(op) {
    const ar = (op.attackDecay >> 4) & 15;
    const dr = op.attackDecay & 15;
    const sl = (op.sustainRelease >> 4) & 15;
    const rr = op.sustainRelease & 15;
    return {
      attack: rateTime(ar, 2.5, 0.004),
      decay: rateTime(dr, 3.2, 0.018),
      sustain: Math.pow(10, -(sl * 3.0) / 20),
      release: rateTime(rr, 3.5, 0.025)
    };
  }

  function totalLevel(level) {
    return Math.pow(10, -(clamp(level, 0, 63) * 0.75) / 20);
  }

  function setWave(osc, waveform) {
    const w = waveform & 3;
    osc.type = w === 0 ? 'sine' : w === 1 ? 'sine' : w === 2 ? 'square' : 'triangle';
  }

  function scheduleEnvelope(param, when, peak, env) {
    const p = Math.max(0.0001, peak);
    const sustain = Math.max(0.0001, p * env.sustain);
    param.cancelScheduledValues(when);
    param.setValueAtTime(0.0001, when);
    param.exponentialRampToValueAtTime(p, when + env.attack);
    param.exponentialRampToValueAtTime(sustain, when + env.attack + env.decay);
  }

  function start(musBytes, looping, volume) {
    stop();

    const ctx = audioContext();
    if (!ctx) {
      console.error('DOOM OPL: WebAudio unavailable');
      return;
    }
    if (ctx.state !== 'running') {
      const p = ctx.resume();
      if (p && p.catch) p.catch(console.error);
    }

    let song;
    try { song = parseMus(musBytes); }
    catch (err) {
      console.error('DOOM OPL: MUS parse failed:', err);
      return;
    }

    const bank = loadBank();
    const master = ctx.createGain();
    master.gain.value = clamp(volume, 0, 127) / 127 * 0.58;
    master.connect(ctx.destination);

    const channels = Array.from({ length: 16 }, () => ({
      program: 0, volume: 1, expression: 1, pan: 0, bend: 0, velocity: 127
    }));
    const groups = new Map();
    let usedVoices = 0;
    let serial = 1;
    let index = 0;
    let loopStart = ctx.currentTime + 0.06;
    let timer = 0;
    let stopped = false;
    let paused = false;
    let pauseAt = 0;

    const keyOf = (ch, key) => ch + ':' + key;

    function baseSemitone(instr, voiceIndex, key, percussion) {
      const voice = instr.voices[voiceIndex];
      let note = percussion ? 60 : key;
      if (instr.flags & FLAG_FIXED) note = instr.fixedNote;
      else note += voice.baseNoteOffset;
      if (voiceIndex === 1) note += ((instr.fineTuning / 2) - 64) / 32;
      while (note < 0) note += 12;
      while (note > 95) note -= 12;
      return note;
    }

    function frequency(note, bend) {
      return 440 * Math.pow(2, (note - 69 + bend) / 12);
    }

    function releaseFmVoice(v, when) {
      if (!v || v.released) return;
      v.released = true;
      const rel = Math.max(v.carEnvDef.release, v.modEnvDef.release);
      try {
        v.carEnv.gain.cancelScheduledValues(when);
        v.carEnv.gain.setTargetAtTime(0.0001, when, Math.max(0.008, rel / 4));
        v.modEnv.gain.cancelScheduledValues(when);
        v.modEnv.gain.setTargetAtTime(0.0001, when, Math.max(0.008, rel / 4));
        const stopAt = when + rel + 0.08;
        v.carrier.stop(stopAt);
        v.modulator.stop(stopAt);
        if (v.vibrato) v.vibrato.stop(stopAt);
      } catch (_) {}
    }

    function releaseGroup(group, when) {
      if (!group) return;
      for (const v of group.voices) releaseFmVoice(v, when);
      usedVoices = Math.max(0, usedVoices - group.voices.length);
    }

    function removeGroup(key, when) {
      const g = groups.get(key);
      if (!g) return;
      releaseGroup(g, when);
      groups.delete(key);
    }

    function ensureSlots(needed, when) {
      while (usedVoices + needed > OPL_VOICE_LIMIT && groups.size) {
        const oldest = groups.keys().next().value;
        removeGroup(oldest, when);
      }
    }

    function createFmVoice(ch, key, instr, voiceIndex, velocity, when, percussion) {
      const c = channels[ch];
      const voice = instr.voices[voiceIndex];
      const mod = voice.mod;
      const car = voice.car;
      const note = baseSemitone(instr, voiceIndex, key, percussion);
      const hz = frequency(note, c.bend);
      const modMul = MULTIPLIER[mod.flags & 15];
      const carMul = MULTIPLIER[car.flags & 15];
      const modHz = Math.max(1, hz * modMul);
      const carHz = Math.max(1, hz * carMul);
      const modEnvDef = envelope(mod);
      const carEnvDef = envelope(car);

      const modulator = ctx.createOscillator();
      const carrier = ctx.createOscillator();
      const modEnv = ctx.createGain();
      const carEnv = ctx.createGain();
      const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

      setWave(modulator, mod.waveform);
      setWave(carrier, car.waveform);
      modulator.frequency.setValueAtTime(modHz, when);
      carrier.frequency.setValueAtTime(carHz, when);

      const channelLevel = Math.pow(clamp(velocity, 0, 127) / 127, 0.72)
        * c.volume * c.expression;
      const carPeak = Math.max(0.0001, channelLevel * totalLevel(car.level) * 0.52);
      const modLevel = totalLevel(mod.level);
      scheduleEnvelope(carEnv.gain, when, carPeak, carEnvDef);
      scheduleEnvelope(modEnv.gain, when, 1, modEnvDef);

      if (panner) panner.pan.setValueAtTime(c.pan * 0.25, when); // OPL2 is mostly mono.
      carEnv.connect(panner || master);
      if (panner) panner.connect(master);
      carrier.connect(carEnv);

      const serialFm = (voice.feedback & 1) === 0;
      const feedback = (voice.feedback >> 1) & 7;
      if (serialFm) {
        const depth = ctx.createGain();
        depth.gain.value = modHz * modLevel * (0.32 + feedback * 0.22);
        modulator.connect(modEnv);
        modEnv.connect(depth);
        depth.connect(carrier.frequency);
      } else {
        const add = ctx.createGain();
        add.gain.value = channelLevel * modLevel * 0.28;
        modulator.connect(modEnv);
        modEnv.connect(add);
        add.connect(panner || master);
      }

      let vibrato = null;
      if ((mod.flags & 0x40) || (car.flags & 0x40)) {
        vibrato = ctx.createOscillator();
        const vibGainCar = ctx.createGain();
        const vibGainMod = ctx.createGain();
        vibrato.frequency.value = 6.1;
        vibGainCar.gain.value = carHz * 0.006;
        vibGainMod.gain.value = modHz * 0.006;
        vibrato.connect(vibGainCar);
        vibrato.connect(vibGainMod);
        if (car.flags & 0x40) vibGainCar.connect(carrier.frequency);
        if (mod.flags & 0x40) vibGainMod.connect(modulator.frequency);
        vibrato.start(when);
      }

      modulator.start(when);
      carrier.start(when);

      return {
        ch, key, note, voiceIndex, instr, modulator, carrier, modEnv, carEnv,
        modEnvDef, carEnvDef, modMul, carMul, vibrato, released: false
      };
    }

    function noteOn(ch, key, velocity, when) {
      const c = channels[ch];
      const percussion = ch === 15;
      let instr;
      if (percussion) {
        if (key < 35 || key > 81) return;
        instr = bank.percussion[key - 35];
      } else {
        instr = bank.main[clamp(c.program | 0, 0, 127)];
      }
      if (!instr) instr = fallbackInstrument();

      const mapKey = keyOf(ch, key);
      removeGroup(mapKey, when);
      const count = (instr.flags & FLAG_2VOICE) ? 2 : 1;
      ensureSlots(count, when);

      const voices = [];
      for (let vi = 0; vi < count; ++vi)
        voices.push(createFmVoice(ch, key, instr, vi, velocity, when, percussion));
      usedVoices += voices.length;
      groups.set(mapKey, { ch, key, voices, order: serial++ });
    }

    function stopChannel(ch, when) {
      for (const [key, group] of Array.from(groups.entries())) {
        if (group.ch === ch) removeGroup(key, when);
      }
    }

    function updatePitch(ch, when) {
      const c = channels[ch];
      for (const group of groups.values()) {
        if (group.ch !== ch) continue;
        for (const v of group.voices) {
          const hz = frequency(v.note, c.bend);
          try {
            v.carrier.frequency.setTargetAtTime(hz * v.carMul, when, 0.008);
            v.modulator.frequency.setTargetAtTime(hz * v.modMul, when, 0.008);
          } catch (_) {}
        }
      }
    }

    function processEvent(e, when) {
      const c = channels[e.ch];
      if (e.type === 0) {
        removeGroup(keyOf(e.ch, e.note), when);
      } else if (e.type === 1) {
        if (e.hasVelocity) c.velocity = e.velocity;
        noteOn(e.ch, e.note, c.velocity, when);
      } else if (e.type === 2) {
        c.bend = (e.pitch - 128) / 64; // roughly the original +/-2 semitone range.
        updatePitch(e.ch, when);
      } else if (e.type === 3) {
        if (e.ctrl === 10 || e.ctrl === 11) stopChannel(e.ch, when);
      } else if (e.type === 4) {
        if (e.ctrl === 0) c.program = e.value;
        else if (e.ctrl === 3) c.volume = e.value / 127;
        else if (e.ctrl === 4) c.pan = clamp((e.value - 64) / 64, -1, 1);
        else if (e.ctrl === 5) c.expression = e.value / 127;
        else if (e.ctrl === 10 || e.ctrl === 11) stopChannel(e.ch, when);
      }
    }

    function resetChannels() {
      for (const c of channels) {
        c.program = 0;
        c.volume = 1;
        c.expression = 1;
        c.pan = 0;
        c.bend = 0;
        c.velocity = 127;
      }
    }

    function releaseAll(when) {
      for (const [key] of Array.from(groups.entries())) removeGroup(key, when);
    }

    function scheduler() {
      if (stopped || paused) return;
      const horizon = ctx.currentTime + 0.12;
      while (index < song.events.length) {
        const e = song.events[index];
        const when = loopStart + e.tick / 140;
        if (when > horizon) break;
        processEvent(e, Math.max(ctx.currentTime, when));
        ++index;
      }
      if (index >= song.events.length && ctx.currentTime >= loopStart + song.duration) {
        if (looping) {
          releaseAll(ctx.currentTime);
          resetChannels();
          index = 0;
          loopStart = ctx.currentTime + 0.04;
        }
      }
    }

    const state = {
      volume: clamp(volume, 0, 127),
      stop() {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        releaseAll(ctx.currentTime);
        try { master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.02); } catch (_) {}
        setTimeout(() => { try { master.disconnect(); } catch (_) {} }, 500);
      },
      pause() {
        if (paused || stopped) return;
        paused = true;
        pauseAt = ctx.currentTime;
        master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.01);
      },
      resume() {
        if (!paused || stopped) return;
        loopStart += ctx.currentTime - pauseAt;
        paused = false;
        master.gain.setTargetAtTime((state.volume / 127) * 0.58, ctx.currentTime, 0.01);
        scheduler();
      },
      setVolume(v) {
        state.volume = clamp(v, 0, 127);
        if (!paused && !stopped)
          master.gain.setTargetAtTime((state.volume / 127) * 0.58, ctx.currentTime, 0.01);
      }
    };

    current = state;
    globalThis.__doomMusic = state;
    timer = setInterval(scheduler, 35);
    scheduler();
    console.log('DOOM OPL: GENMIDI 2-op FM synth started;', bank.source,
      song.events.length, 'events; voice limit', OPL_VOICE_LIMIT);
  }

  function stop() {
    if (current && current.stop) current.stop();
    current = null;
    globalThis.__doomMusic = null;
  }

  function pause() { if (current && current.pause) current.pause(); }
  function resume() { if (current && current.resume) current.resume(); }
  function setVolume(v) { if (current && current.setVolume) current.setVolume(v); }

  globalThis.DoomOPL2Music = { start, stop, pause, resume, setVolume };
})();
