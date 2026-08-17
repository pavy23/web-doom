// Browser audio backend written for the direct id Software LinuxDOOM 1.10 port.
//
// This file replaces the original Linux OSS/sndserver i_sound.c.  It does not
// use doomgeneric's sound layer.  DOOM's DMX sound-effect lumps are decoded
// here, and DOOM MUS music is converted here to a standard MIDI stream before
// SDL_mixer renders it through the browser's WebAudio backend.

#include "doomdef.h"
#include "doomstat.h"
#include "sounds.h"
#include "w_wad.h"
#include "z_zone.h"
#include "i_sound.h"

#include <SDL.h>
#include <SDL_mixer.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WEB_MIX_FREQ 44100
#define WEB_MIX_CHANNELS 32
#define MIDI_DIVISION 70

// LinuxDOOM's config code still references this historical variable even
// though the browser backend has no external sndserver process.
char *sndserver_filename = "";

typedef struct
{
    Mix_Chunk *chunk;
} web_sfx_channel_t;

static web_sfx_channel_t web_channels[WEB_MIX_CHANNELS];
static int web_audio_ready;
static Mix_Music *web_music;
static unsigned char *web_music_midi;
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

static void put_be16(unsigned char *p, unsigned int v)
{
    p[0] = (unsigned char)((v >> 8) & 255);
    p[1] = (unsigned char)(v & 255);
}

static void put_be32(unsigned char *p, unsigned int v)
{
    p[0] = (unsigned char)((v >> 24) & 255);
    p[1] = (unsigned char)((v >> 16) & 255);
    p[2] = (unsigned char)((v >> 8) & 255);
    p[3] = (unsigned char)(v & 255);
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

// Convert a DOOM/DMX type-3 SFX lump into an in-memory WAV.  Encoding pitch
// into the WAV sample rate gives us the original DOOM pitch variation while
// allowing SDL_mixer to perform the actual resampling to the browser device.
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
    put_le16(wav + 20, 1U);       // PCM
    put_le16(wav + 22, 1U);       // mono
    put_le32(wav + 24, pitched_rate);
    put_le32(wav + 28, pitched_rate); // 8-bit mono => 1 byte/sample
    put_le16(wav + 32, 1U);
    put_le16(wav + 34, 8U);
    memcpy(wav + 36, "data", 4);
    put_le32(wav + 40, sample_count);
    memcpy(wav + 44, dmx + data_offset, sample_count);

    *wav_len = (int)total;
    return wav;
}

// -------------------------------------------------------------------------
// Minimal MUS -> Standard MIDI File converter.
//
// DOOM MUS runs at 140 ticks/sec.  A MIDI division of 70 with a 500000 us
// quarter-note tempo gives the same 140 ticks/sec time base.
// -------------------------------------------------------------------------

typedef struct
{
    unsigned char *data;
    size_t len;
    size_t cap;
} midi_buf_t;

static int midi_reserve(midi_buf_t *b, size_t extra)
{
    size_t needed;
    size_t cap;
    unsigned char *p;

    needed = b->len + extra;
    if (needed <= b->cap)
        return 1;

    cap = b->cap ? b->cap : 1024;
    while (cap < needed)
        cap *= 2;

    p = (unsigned char *)realloc(b->data, cap);
    if (!p)
        return 0;

    b->data = p;
    b->cap = cap;
    return 1;
}

static int midi_byte(midi_buf_t *b, unsigned int v)
{
    if (!midi_reserve(b, 1))
        return 0;
    b->data[b->len++] = (unsigned char)(v & 255);
    return 1;
}

static int midi_bytes(midi_buf_t *b, const void *src, size_t n)
{
    if (!midi_reserve(b, n))
        return 0;
    memcpy(b->data + b->len, src, n);
    b->len += n;
    return 1;
}

static int midi_varlen(midi_buf_t *b, unsigned int value)
{
    unsigned char out[5];
    int n;

    n = 0;
    out[n++] = (unsigned char)(value & 127U);
    while ((value >>= 7) != 0)
        out[n++] = (unsigned char)((value & 127U) | 128U);

    while (n-- > 0)
        if (!midi_byte(b, out[n]))
            return 0;
    return 1;
}

static int mus_midi_channel(int mus_channel)
{
    if (mus_channel == 15)
        return 9; // percussion
    if (mus_channel >= 9)
        return mus_channel + 1; // skip MIDI percussion channel 9
    return mus_channel;
}

static int emit_midi_event(midi_buf_t *track, unsigned int delta,
                           int status, int a, int b, int bytes)
{
    if (!midi_varlen(track, delta)) return 0;
    if (!midi_byte(track, (unsigned int)status)) return 0;
    if (bytes >= 1 && !midi_byte(track, (unsigned int)a)) return 0;
    if (bytes >= 2 && !midi_byte(track, (unsigned int)b)) return 0;
    return 1;
}

static unsigned char *mus_to_midi(const unsigned char *mus, int *midi_len)
{
    static const unsigned char ctrl_map[15] =
    {
        0,   // program change marker
        0,   // bank select
        1,   // modulation
        7,   // volume
        10,  // pan
        11,  // expression
        91,  // reverb
        93,  // chorus
        64,  // sustain
        67,  // soft pedal
        120, // all sounds off
        123, // all notes off
        126, // mono
        127, // poly
        121  // reset controllers
    };

    midi_buf_t track;
    unsigned char velocity[16];
    unsigned int score_len;
    unsigned int score_start;
    unsigned int score_end;
    unsigned int pos;
    unsigned int pending_delta;
    int done;
    int i;
    unsigned char *out;
    size_t total;

    memset(&track, 0, sizeof(track));
    memset(velocity, 127, sizeof(velocity));

    if (!mus || !midi_len || memcmp(mus, "MUS\x1a", 4) != 0)
        return 0;

    score_len = read_le16(mus + 4);
    score_start = read_le16(mus + 6);
    score_end = score_start + score_len;
    if (score_start < 16 || score_len == 0 || score_end < score_start)
        return 0;

    // Tempo meta-event: 500000 microseconds per quarter note.
    if (!midi_varlen(&track, 0) ||
        !midi_byte(&track, 0xff) || !midi_byte(&track, 0x51) ||
        !midi_byte(&track, 3) || !midi_byte(&track, 0x07) ||
        !midi_byte(&track, 0xa1) || !midi_byte(&track, 0x20))
        goto fail;

    pos = score_start;
    pending_delta = 0;
    done = 0;

    while (!done && pos < score_end)
    {
        int last;
        int type;
        int mch;
        int ch;
        unsigned int event_delta;
        unsigned int ev;

        ev = mus[pos++];
        last = (ev & 0x80U) != 0;
        type = (int)((ev >> 4) & 7U);
        mch = (int)(ev & 15U);
        ch = mus_midi_channel(mch);
        event_delta = pending_delta;
        pending_delta = 0;

        switch (type)
        {
            case 0: // release note
            {
                int note;
                if (pos >= score_end) goto fail;
                note = mus[pos++] & 127;
                if (!emit_midi_event(&track, event_delta, 0x80 | ch,
                                     note, 64, 2)) goto fail;
                break;
            }

            case 1: // play note
            {
                int note;
                int vel;
                if (pos >= score_end) goto fail;
                note = mus[pos++];
                vel = velocity[mch];
                if (note & 0x80)
                {
                    if (pos >= score_end) goto fail;
                    vel = mus[pos++] & 127;
                    velocity[mch] = (unsigned char)vel;
                }
                if (!emit_midi_event(&track, event_delta, 0x90 | ch,
                                     note & 127, vel, 2)) goto fail;
                break;
            }

            case 2: // pitch wheel
            {
                unsigned int value;
                if (pos >= score_end) goto fail;
                value = (unsigned int)mus[pos++] << 6;
                if (!emit_midi_event(&track, event_delta, 0xe0 | ch,
                                     (int)(value & 127U),
                                     (int)((value >> 7) & 127U), 2)) goto fail;
                break;
            }

            case 3: // system event
            {
                int ctrl;
                int value;
                if (pos >= score_end) goto fail;
                ctrl = mus[pos++] & 127;
                if (ctrl < 10 || ctrl > 14) goto fail;
                value = (ctrl == 12) ? 1 : 0;
                if (!emit_midi_event(&track, event_delta, 0xb0 | ch,
                                     ctrl_map[ctrl], value, 2)) goto fail;
                break;
            }

            case 4: // controller or program change
            {
                int ctrl;
                int value;
                if (pos + 1 >= score_end) goto fail;
                ctrl = mus[pos++] & 127;
                value = mus[pos++] & 127;
                if (ctrl > 14) goto fail;
                if (ctrl == 0)
                {
                    if (!emit_midi_event(&track, event_delta, 0xc0 | ch,
                                         value, 0, 1)) goto fail;
                }
                else
                {
                    if (!emit_midi_event(&track, event_delta, 0xb0 | ch,
                                         ctrl_map[ctrl], value, 2)) goto fail;
                }
                break;
            }

            case 6: // end score
                done = 1;
                if (!midi_varlen(&track, event_delta)) goto fail;
                if (!midi_byte(&track, 0xff) || !midi_byte(&track, 0x2f) ||
                    !midi_byte(&track, 0)) goto fail;
                break;

            default:
                goto fail;
        }

        if (last && !done)
        {
            unsigned int t;
            unsigned int b;
            t = 0;
            do
            {
                if (pos >= score_end) goto fail;
                b = mus[pos++];
                t = (t << 7) | (b & 127U);
            } while (b & 128U);
            pending_delta += t;
        }
    }

    if (!done)
    {
        if (!midi_varlen(&track, pending_delta) ||
            !midi_byte(&track, 0xff) || !midi_byte(&track, 0x2f) ||
            !midi_byte(&track, 0)) goto fail;
    }

    total = 14U + 8U + track.len;
    out = (unsigned char *)malloc(total);
    if (!out) goto fail;

    memcpy(out, "MThd", 4);
    put_be32(out + 4, 6);
    put_be16(out + 8, 0);
    put_be16(out + 10, 1);
    put_be16(out + 12, MIDI_DIVISION);
    memcpy(out + 14, "MTrk", 4);
    put_be32(out + 18, (unsigned int)track.len);
    memcpy(out + 22, track.data, track.len);

    free(track.data);
    *midi_len = (int)total;
    return out;

fail:
    free(track.data);
    return 0;
}

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

    Mix_Init(MIX_INIT_MID);
    if (Mix_OpenAudio(WEB_MIX_FREQ, MIX_DEFAULT_FORMAT, 2, 1024) < 0)
    {
        fprintf(stderr, "I_InitSound: Mix_OpenAudio failed: %s\n", Mix_GetError());
        return;
    }

    Mix_AllocateChannels(WEB_MIX_CHANNELS);
    for (i = 0; i < WEB_MIX_CHANNELS; ++i)
        web_channels[i].chunk = 0;

    Mix_VolumeMusic((web_music_volume * MIX_MAX_VOLUME) / 127);
    web_audio_ready = 1;
    fprintf(stderr, "I_InitSound: direct SDL/WebAudio backend ready\n");
}

void I_UpdateSound(void) {}
void I_SubmitSound(void) {}
void I_SetChannels(void) {}

void I_ShutdownSound(void)
{
    int i;

    if (!web_audio_ready)
        return;

    Mix_HaltMusic();
    if (web_music)
    {
        Mix_FreeMusic(web_music);
        web_music = 0;
    }
    if (web_music_midi)
    {
        free(web_music_midi);
        web_music_midi = 0;
    }

    for (i = 0; i < WEB_MIX_CHANNELS; ++i)
    {
        Mix_HaltChannel(i);
        free_channel_chunk(i);
    }

    Mix_CloseAudio();
    Mix_Quit();
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
    (void)pitch; // initial pitch is encoded into the generated WAV sample rate
    channel = handle - 1;
    set_channel_params(channel, vol, sep);
}

void I_InitMusic(void)
{
    if (!web_audio_ready)
        I_InitSound();
}

void I_ShutdownMusic(void)
{
    Mix_HaltMusic();
    if (web_music)
    {
        Mix_FreeMusic(web_music);
        web_music = 0;
    }
    if (web_music_midi)
    {
        free(web_music_midi);
        web_music_midi = 0;
    }
}

void I_SetMusicVolume(int volume)
{
    if (volume < 0) volume = 0;
    if (volume > 127) volume = 127;
    web_music_volume = volume;
    if (web_audio_ready)
        Mix_VolumeMusic((volume * MIX_MAX_VOLUME) / 127);
}

void I_PauseSong(int handle)
{
    (void)handle;
    if (Mix_PlayingMusic())
        Mix_PauseMusic();
}

void I_ResumeSong(int handle)
{
    (void)handle;
    if (Mix_PausedMusic())
        Mix_ResumeMusic();
}

int I_RegisterSong(void *data)
{
    int midi_len;
    SDL_RWops *rw;

    if (!data)
        return 0;

    I_ShutdownMusic();
    midi_len = 0;
    web_music_midi = mus_to_midi((const unsigned char *)data, &midi_len);
    if (!web_music_midi)
    {
        fprintf(stderr, "I_RegisterSong: MUS conversion failed\n");
        return 0;
    }

    rw = SDL_RWFromConstMem(web_music_midi, midi_len);
    if (!rw)
        return 0;

    web_music = Mix_LoadMUS_RW(rw, 1);
    if (!web_music)
    {
        fprintf(stderr, "I_RegisterSong: MIDI load failed: %s\n", Mix_GetError());
        free(web_music_midi);
        web_music_midi = 0;
        return 0;
    }

    return 1;
}

void I_PlaySong(int handle, int looping)
{
    (void)handle;
    if (!web_music)
        return;
    Mix_VolumeMusic((web_music_volume * MIX_MAX_VOLUME) / 127);
    if (Mix_PlayMusic(web_music, looping ? -1 : 0) < 0)
        fprintf(stderr, "I_PlaySong: %s\n", Mix_GetError());
}

void I_StopSong(int handle)
{
    (void)handle;
    Mix_HaltMusic();
}

void I_UnRegisterSong(int handle)
{
    (void)handle;
    Mix_HaltMusic();
    if (web_music)
    {
        Mix_FreeMusic(web_music);
        web_music = 0;
    }
    if (web_music_midi)
    {
        free(web_music_midi);
        web_music_midi = 0;
    }
}
