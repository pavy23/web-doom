// Browser audio backend written for the direct id Software LinuxDOOM 1.10 port.
//
// This file replaces the original Linux OSS/sndserver i_sound.c. It does not
// use doomgeneric's sound layer. DOOM DMX sound-effect lumps are decoded here
// and mixed by SDL2_mixer. DOOM MUS music is parsed and synthesized directly
// with the browser WebAudio API, so no external MIDI soundfont is required.

#include "doomdef.h"
#include "doomstat.h"
#include "sounds.h"
#include "w_wad.h"
#include "z_zone.h"
#include "i_sound.h"

#include <SDL.h>
#include <SDL_mixer.h>
#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WEB_MIX_FREQ 44100
#define WEB_MIX_CHANNELS 32

// LinuxDOOM's config code still references this historical variable even
// though the browser backend has no external sndserver process.
char *sndserver_filename = "";

typedef struct
{
    Mix_Chunk *chunk;
} web_sfx_channel_t;

static web_sfx_channel_t web_channels[WEB_MIX_CHANNELS];
static int web_audio_ready;
static const unsigned char *web_music_data;
static int web_music_len;
static int web_music_volume = 127;

static unsigned int read_le16(const unsigned char *p)
{
    return (unsigned int)p[0] | ((unsigned int)p[1] << 8);
}

static unsigned int read_le32(const unsigned char *p)
{
    return (unsigned int)p[0]
        | ((unsigned int)p[1] << 8)
        | ((unsigned int)p[2] << 16)
        | ((unsigned int)p[3] << 24);
}

static void put_le16(unsigned char *p, unsigned int v)
{
    p[0] = (unsigned char)(v & 255);
    p[1] = (unsigned char)((v >> 8) & 255);
}

static void put_le32(unsigned char *p, unsigned int v)
{
    p[0] = (unsigned char)(v & 255);
    p[1] = (unsigned char)((v >> 8) & 255);
    p[2] = (unsigned char)((v >> 16) & 255);
    p[3] = (unsigned char)((v >> 24) & 255);
}

static void free_channel_chunk(int channel)
{
    if (channel < 0 || channel >= WEB_MIX_CHANNELS)
        return;

    if (web_channels[channel].chunk)
    {
        Mix_FreeChunk(web_channels[channel].chunk);
        web_channels[channel].chunk = 0;
    }
}

static void set_channel_params(int channel, int vol, int sep)
{
    int mixer_volume;
    int left;
    int right;

    if (channel < 0 || channel >= WEB_MIX_CHANNELS)
        return;

    if (vol < 0) vol = 0;
    if (vol > 127) vol = 127;
    if (sep < 0) sep = 0;
    if (sep > 255) sep = 255;

    mixer_volume = (vol * MIX_MAX_VOLUME) / 127;
    Mix_Volume(channel, mixer_volume);

    // DOOM separation: 0 = hard left, 128 = center, 255 = hard right.
    if (sep <= 128)
    {
        left = 255;
        right = sep * 2;
    }
    else
    {
        left = (255 - sep) * 2;
        right = 255;
    }

    if (left < 0) left = 0;
    if (left > 255) left = 255;
    if (right < 0) right = 0;
    if (right > 255) right = 255;
    Mix_SetPanning(channel, (Uint8)left, (Uint8)right);
}

// Convert a DOOM/DMX type-3 SFX lump into an in-memory WAV. Encoding pitch
// into the WAV sample rate gives us the original DOOM pitch variation while
// allowing SDL_mixer to resample to the browser device.
static unsigned char *dmx_to_wav(const unsigned char *dmx, int lump_len,
                                 int pitch, int *wav_len)
{
    unsigned int format;
    unsigned int sample_rate;
    unsigned int sample_count;
    unsigned int pitched_rate;
    unsigned int data_offset;
    unsigned int usable;
    unsigned int total;
    unsigned char *wav;

    if (!dmx || lump_len < 8 || !wav_len)
        return 0;

    format = read_le16(dmx);
    sample_rate = read_le16(dmx + 2);
    sample_count = read_le32(dmx + 4);
    data_offset = 8;

    if (format != 3 || sample_rate == 0)
        return 0;

    usable = (unsigned int)(lump_len - (int)data_offset);
    if (sample_count > usable)
        sample_count = usable;

    if (pitch < 1) pitch = 1;
    if (pitch > 255) pitch = 255;
    pitched_rate = (sample_rate * (unsigned int)pitch) / 128U;
    if (pitched_rate < 1000U) pitched_rate = 1000U;

    total = 44U + sample_count;
    wav = (unsigned char *)malloc(total);
    if (!wav)
        return 0;

    memcpy(wav, "RIFF", 4);
    put_le32(wav + 4, total - 8U);
    memcpy(wav + 8, "WAVEfmt ", 8);
    put_le32(wav + 16, 16U);
    put_le16(wav + 20, 1U);
    put_le16(wav + 22, 1U);
    put_le32(wav + 24, pitched_rate);
    put_le32(wav + 28, pitched_rate);
    put_le16(wav + 32, 1U);
    put_le16(wav + 34, 8U);
    memcpy(wav + 36, "data", 4);
    put_le32(wav + 40, sample_count);
    memcpy(wav + 44, dmx + data_offset, sample_count);

    *wav_len = (int)total;
    return wav;
}

// -------------------------------------------------------------------------
// Direct MUS -> WebAudio synthesizer.
//
// The browser-side code parses the original MUS stream, schedules events at
// DOOM's native 140 Hz tick rate, and synthesizes melodic/percussion voices
// without relying on Timidity, a SoundFont, or the browser's MIDI support.
// -------------------------------------------------------------------------

EM_JS(void, web_music_js_start,
      (const unsigned char *ptr, int len, int looping, int volume),
{
    function getContext() {
        if (typeof SDL2 !== 'undefined' && SDL2.audioContext) {
            return SDL2.audioContext;
        }
        if (globalThis.__doomMusicContext) {
            return globalThis.__doomMusicContext;
        }
        const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Ctor) return null;
        globalThis.__doomMusicContext = new Ctor();
        return globalThis.__doomMusicContext;
    }

    if (globalThis.__doomMusic && globalThis.__doomMusic.stop) {
        globalThis.__doomMusic.stop();
    }

    const ctx = getContext();
    if (!ctx) {
        console.error('DOOM music: WebAudio is unavailable');
        return;
    }
    if (ctx.state !== 'running') {
        const p = ctx.resume();
        if (p && p.catch) p.catch(console.error);
    }

    const bytes = HEAPU8.slice(ptr, ptr + len);
    const u16 = o => bytes[o] | (bytes[o + 1] << 8);
    if (len < 16 || bytes[0] !== 0x4d || bytes[1] !== 0x55 ||
        bytes[2] !== 0x53 || bytes[3] !== 0x1a) {
        console.error('DOOM music: invalid MUS header');
        return;
    }

    const scoreLen = u16(4);
    const scoreStart = u16(6);
    const scoreEnd = Math.min(bytes.length, scoreStart + scoreLen);
    let pos = scoreStart;
    let tick = 0;
    const events = [];

    while (pos < scoreEnd) {
        const ev = bytes[pos++];
        const last = (ev & 0x80) !== 0;
        const type = (ev >> 4) & 7;
        const ch = ev & 15;
        const out = { tick, type, ch };

        if (type === 0) {
            if (pos >= scoreEnd) break;
            out.note = bytes[pos++] & 127;
            events.push(out);
        } else if (type === 1) {
            if (pos >= scoreEnd) break;
            const note = bytes[pos++];
            out.note = note & 127;
            out.hasVelocity = (note & 0x80) !== 0;
            if (out.hasVelocity) {
                if (pos >= scoreEnd) break;
                out.velocity = bytes[pos++] & 127;
            }
            events.push(out);
        } else if (type === 2) {
            if (pos >= scoreEnd) break;
            out.pitch = bytes[pos++] & 255;
            events.push(out);
        } else if (type === 3) {
            if (pos >= scoreEnd) break;
            out.ctrl = bytes[pos++] & 127;
            events.push(out);
        } else if (type === 4) {
            if (pos + 1 >= scoreEnd) break;
            out.ctrl = bytes[pos++] & 127;
            out.value = bytes[pos++] & 127;
            events.push(out);
        } else if (type === 6) {
            events.push(out);
            break;
        } else {
            console.warn('DOOM music: unsupported MUS event', type);
            break;
        }

        if (last && type !== 6) {
            let delay = 0;
            let b = 0;
            do {
                if (pos >= scoreEnd) break;
                b = bytes[pos++];
                delay = (delay << 7) | (b & 127);
            } while (b & 0x80);
            tick += delay;
        }
    }

    const duration = Math.max(0.25, tick / 140 + 0.15);
    const master = ctx.createGain();
    const volScale = Math.max(0, Math.min(127, volume)) / 127;
    master.gain.value = volScale * 0.42;
    master.connect(ctx.destination);

    const channels = Array.from({length: 16}, () => ({
        program: 0,
        volume: 1,
        expression: 1,
        pan: 0,
        bend: 0,
        velocity: 127
    }));
    const active = new Map();
    let index = 0;
    let loopStart = ctx.currentTime + 0.06;
    let timer = 0;
    let stopped = false;
    let paused = false;
    let pauseAt = 0;

    const keyOf = (ch, note) => ch + ':' + note;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const freqFor = (note, bend) => 440 * Math.pow(2, (note - 69 + bend) / 12);

    function waveform(program) {
        if (program >= 24 && program <= 31) return 'sawtooth';   // guitars
        if (program >= 32 && program <= 39) return 'square';     // bass
        if (program >= 40 && program <= 55) return 'sawtooth';   // strings/brass
        if (program >= 80 && program <= 87) return 'square';     // synth leads
        if (program >= 88 && program <= 103) return 'triangle';  // pads/fx
        return 'triangle';
    }

    function releaseVoice(v, when) {
        if (!v || v.released) return;
        v.released = true;
        try {
            v.gain.gain.cancelScheduledValues(when);
            v.gain.gain.setTargetAtTime(0.0001, when, 0.025);
            v.osc.stop(when + 0.18);
        } catch (_) {}
    }

    function stopChannel(ch, when) {
        for (const [key, v] of active) {
            if (v.ch === ch) {
                releaseVoice(v, when);
                active.delete(key);
            }
        }
    }

    function noteOn(ch, note, velocity, when) {
        const c = channels[ch];
        if (ch === 15) {
            const g = ctx.createGain();
            const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            if (pan) pan.pan.setValueAtTime(c.pan, when);
            g.connect(pan || master);
            if (pan) pan.connect(master);

            const level = clamp((velocity / 127) * c.volume * c.expression, 0, 1);
            if (note === 35 || note === 36) {
                const o = ctx.createOscillator();
                o.type = 'sine';
                o.frequency.setValueAtTime(130, when);
                o.frequency.exponentialRampToValueAtTime(48, when + 0.12);
                g.gain.setValueAtTime(level * 0.55, when);
                g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
                o.connect(g);
                o.start(when);
                o.stop(when + 0.2);
            } else {
                const length = (note === 42 || note === 44 || note === 46) ? 0.09 : 0.18;
                const frames = Math.max(1, Math.floor(ctx.sampleRate * length));
                const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
                const data = buf.getChannelData(0);
                for (let i = 0; i < frames; ++i) data[i] = Math.random() * 2 - 1;
                const src = ctx.createBufferSource();
                src.buffer = buf;
                const filter = ctx.createBiquadFilter();
                filter.type = (note === 42 || note === 44 || note === 46) ? 'highpass' : 'bandpass';
                filter.frequency.value = (note === 42 || note === 44 || note === 46) ? 6500 : 1800;
                g.gain.setValueAtTime(level * 0.28, when);
                g.gain.exponentialRampToValueAtTime(0.0001, when + length);
                src.connect(filter);
                filter.connect(g);
                src.start(when);
                src.stop(when + length);
            }
            return;
        }

        const old = active.get(keyOf(ch, note));
        if (old) releaseVoice(old, when);

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        const level = clamp((velocity / 127) * c.volume * c.expression, 0, 1);

        osc.type = waveform(c.program);
        osc.frequency.setValueAtTime(freqFor(note, c.bend), when);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(c.program >= 24 && c.program <= 39 ? 3400 : 5200, when);
        filter.Q.value = 0.35;
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * 0.16), when + 0.008);
        if (panner) panner.pan.setValueAtTime(c.pan, when);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(panner || master);
        if (panner) panner.connect(master);
        osc.start(when);

        active.set(keyOf(ch, note), { ch, note, osc, gain, released: false });
    }

    function processEvent(e, when) {
        const c = channels[e.ch];
        if (e.type === 0) {
            const key = keyOf(e.ch, e.note);
            const v = active.get(key);
            releaseVoice(v, when);
            active.delete(key);
            return;
        }
        if (e.type === 1) {
            if (e.hasVelocity) c.velocity = e.velocity;
            noteOn(e.ch, e.note, c.velocity, when);
            return;
        }
        if (e.type === 2) {
            c.bend = ((e.pitch - 128) / 64) * 2;
            for (const v of active.values()) {
                if (v.ch === e.ch && !v.released) {
                    try {
                        v.osc.frequency.setTargetAtTime(freqFor(v.note, c.bend), when, 0.008);
                    } catch (_) {}
                }
            }
            return;
        }
        if (e.type === 3) {
            if (e.ctrl === 10 || e.ctrl === 11) stopChannel(e.ch, when);
            return;
        }
        if (e.type === 4) {
            if (e.ctrl === 0) c.program = e.value;
            else if (e.ctrl === 3) c.volume = e.value / 127;
            else if (e.ctrl === 4) c.pan = clamp((e.value - 64) / 64, -1, 1);
            else if (e.ctrl === 5) c.expression = e.value / 127;
            else if (e.ctrl === 10 || e.ctrl === 11) stopChannel(e.ch, when);
        }
    }

    function resetChannels() {
        for (let i = 0; i < channels.length; ++i) {
            channels[i].program = 0;
            channels[i].volume = 1;
            channels[i].expression = 1;
            channels[i].pan = 0;
            channels[i].bend = 0;
            channels[i].velocity = 127;
        }
    }

    function scheduler() {
        if (stopped || paused) return;
        const horizon = ctx.currentTime + 0.12;
        while (index < events.length) {
            const e = events[index];
            const when = loopStart + e.tick / 140;
            if (when > horizon) break;
            processEvent(e, Math.max(ctx.currentTime, when));
            ++index;
        }

        if (index >= events.length && ctx.currentTime >= loopStart + duration) {
            if (looping) {
                for (const v of active.values()) releaseVoice(v, ctx.currentTime);
                active.clear();
                resetChannels();
                index = 0;
                loopStart = ctx.currentTime + 0.04;
            }
        }
    }

    const state = {
        ctx,
        master,
        stop() {
            if (stopped) return;
            stopped = true;
            if (timer) clearInterval(timer);
            for (const v of active.values()) releaseVoice(v, ctx.currentTime);
            active.clear();
            try { master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.02); } catch (_) {}
            setTimeout(() => { try { master.disconnect(); } catch (_) {} }, 250);
        },
        pause() {
            if (paused || stopped) return;
            paused = true;
            pauseAt = ctx.currentTime;
            master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.01);
        },
        resume() {
            if (!paused || stopped) return;
            const delta = ctx.currentTime - pauseAt;
            loopStart += delta;
            paused = false;
            master.gain.setTargetAtTime((state.volume / 127) * 0.42, ctx.currentTime, 0.01);
            scheduler();
        },
        setVolume(v) {
            state.volume = clamp(v, 0, 127);
            if (!paused && !stopped) {
                master.gain.setTargetAtTime((state.volume / 127) * 0.42, ctx.currentTime, 0.01);
            }
        },
        volume: clamp(volume, 0, 127)
    };

    globalThis.__doomMusic = state;
    timer = setInterval(scheduler, 35);
    scheduler();
    console.log('DOOM music: direct MUS/WebAudio synthesizer started', events.length, 'events');
});

EM_JS(void, web_music_js_stop, (), {
    if (globalThis.__doomMusic && globalThis.__doomMusic.stop) {
        globalThis.__doomMusic.stop();
        globalThis.__doomMusic = null;
    }
});

EM_JS(void, web_music_js_pause, (), {
    if (globalThis.__doomMusic && globalThis.__doomMusic.pause)
        globalThis.__doomMusic.pause();
});

EM_JS(void, web_music_js_resume, (), {
    if (globalThis.__doomMusic && globalThis.__doomMusic.resume)
        globalThis.__doomMusic.resume();
});

EM_JS(void, web_music_js_set_volume, (int volume), {
    if (globalThis.__doomMusic && globalThis.__doomMusic.setVolume)
        globalThis.__doomMusic.setVolume(volume);
});

void I_InitSound(void)
{
    int i;

    if (web_audio_ready)
        return;

    if (SDL_InitSubSystem(SDL_INIT_AUDIO) < 0)
    {
        fprintf(stderr, "I_InitSound: SDL audio init failed: %s\n", SDL_GetError());
        return;
    }

    if (Mix_OpenAudio(WEB_MIX_FREQ, MIX_DEFAULT_FORMAT, 2, 1024) < 0)
    {
        fprintf(stderr, "I_InitSound: Mix_OpenAudio failed: %s\n", Mix_GetError());
        return;
    }

    Mix_AllocateChannels(WEB_MIX_CHANNELS);
    for (i = 0; i < WEB_MIX_CHANNELS; ++i)
        web_channels[i].chunk = 0;

    web_audio_ready = 1;
    fprintf(stderr, "I_InitSound: direct SDL/WebAudio SFX backend ready\n");
}

void I_UpdateSound(void) {}
void I_SubmitSound(void) {}
void I_SetChannels(void) {}

void I_ShutdownSound(void)
{
    int i;

    web_music_js_stop();
    web_music_data = 0;
    web_music_len = 0;

    if (!web_audio_ready)
        return;

    for (i = 0; i < WEB_MIX_CHANNELS; ++i)
    {
        Mix_HaltChannel(i);
        free_channel_chunk(i);
    }

    Mix_CloseAudio();
    SDL_QuitSubSystem(SDL_INIT_AUDIO);
    web_audio_ready = 0;
}

int I_GetSfxLumpNum(sfxinfo_t *sfxinfo)
{
    char namebuf[9];
    namebuf[0] = 'd';
    namebuf[1] = 's';
    namebuf[2] = '\0';
    strncat(namebuf, sfxinfo->name, 6);
    return W_GetNumForName(namebuf);
}

int I_StartSound(int id, int vol, int sep, int pitch, int priority)
{
    int lumpnum;
    int lump_len;
    unsigned char *dmx;
    unsigned char *wav;
    int wav_len;
    SDL_RWops *rw;
    Mix_Chunk *chunk;
    int channel;

    (void)priority;

    if (!web_audio_ready || id <= 0 || id >= NUMSFX)
        return 0;

    lumpnum = S_sfx[id].lumpnum;
    if (lumpnum < 0)
        lumpnum = I_GetSfxLumpNum(&S_sfx[id]);

    lump_len = W_LumpLength(lumpnum);
    dmx = (unsigned char *)W_CacheLumpNum(lumpnum, PU_CACHE);
    wav_len = 0;
    wav = dmx_to_wav(dmx, lump_len, pitch, &wav_len);
    if (!wav)
        return 0;

    rw = SDL_RWFromMem(wav, wav_len);
    if (!rw)
    {
        free(wav);
        return 0;
    }

    chunk = Mix_LoadWAV_RW(rw, 1);
    free(wav);
    if (!chunk)
    {
        fprintf(stderr, "I_StartSound: decode failed for sfx %d: %s\n",
                id, Mix_GetError());
        return 0;
    }

    channel = Mix_PlayChannel(-1, chunk, 0);
    if (channel < 0 || channel >= WEB_MIX_CHANNELS)
    {
        Mix_FreeChunk(chunk);
        return 0;
    }

    free_channel_chunk(channel);
    web_channels[channel].chunk = chunk;
    set_channel_params(channel, vol, sep);
    return channel + 1;
}

void I_StopSound(int handle)
{
    int channel;
    channel = handle - 1;
    if (channel < 0 || channel >= WEB_MIX_CHANNELS)
        return;
    Mix_HaltChannel(channel);
    free_channel_chunk(channel);
}

int I_SoundIsPlaying(int handle)
{
    int channel;
    int playing;
    channel = handle - 1;
    if (channel < 0 || channel >= WEB_MIX_CHANNELS)
        return 0;

    playing = Mix_Playing(channel);
    if (!playing)
        free_channel_chunk(channel);
    return playing ? 1 : 0;
}

void I_UpdateSoundParams(int handle, int vol, int sep, int pitch)
{
    int channel;
    (void)pitch;
    channel = handle - 1;
    set_channel_params(channel, vol, sep);
}

void I_InitMusic(void)
{
    // Music is synthesized directly with WebAudio when I_PlaySong is called.
}

void I_ShutdownMusic(void)
{
    web_music_js_stop();
    web_music_data = 0;
    web_music_len = 0;
}

void I_SetMusicVolume(int volume)
{
    if (volume < 0) volume = 0;
    if (volume > 127) volume = 127;
    web_music_volume = volume;
    web_music_js_set_volume(volume);
}

void I_PauseSong(int handle)
{
    (void)handle;
    web_music_js_pause();
}

void I_ResumeSong(int handle)
{
    (void)handle;
    web_music_js_resume();
}

int I_RegisterSong(void *data)
{
    unsigned int score_len;
    unsigned int score_start;

    if (!data)
        return 0;

    web_music_js_stop();
    web_music_data = (const unsigned char *)data;

    if (memcmp(web_music_data, "MUS\x1a", 4) != 0)
    {
        fprintf(stderr, "I_RegisterSong: invalid MUS header\n");
        web_music_data = 0;
        web_music_len = 0;
        return 0;
    }

    score_len = read_le16(web_music_data + 4);
    score_start = read_le16(web_music_data + 6);
    web_music_len = (int)(score_start + score_len);
    if (web_music_len < 16)
    {
        web_music_data = 0;
        web_music_len = 0;
        return 0;
    }

    return 1;
}

void I_PlaySong(int handle, int looping)
{
    (void)handle;
    if (!web_music_data || web_music_len <= 0)
        return;

    web_music_js_start(web_music_data, web_music_len,
                       looping ? 1 : 0, web_music_volume);
}

void I_StopSong(int handle)
{
    (void)handle;
    web_music_js_stop();
}

void I_UnRegisterSong(int handle)
{
    (void)handle;
    web_music_js_stop();
    web_music_data = 0;
    web_music_len = 0;
}
