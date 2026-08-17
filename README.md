# Web DOOM — Direct LinuxDOOM Browser Port

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly.

Instead of using an existing browser/source-port framework as the runtime layer, this project takes the original LinuxDOOM source and replaces its platform-specific `i_*` interfaces with browser implementations maintained in this repository.

## Play

### ⭐ Direct LinuxDOOM port — current development version

[▶ **Play the direct WebAssembly port**](https://pavy23.github.io/web-doom/direct/)

This is the version currently being developed.

### Legacy / reference build

[▶ Play the earlier doomgeneric-based build](https://pavy23.github.io/web-doom/)

The legacy build is kept as a working reference and comparison point. It uses the existing [doomgeneric](https://github.com/ozkl/doomgeneric) portability layer, while the `/direct/` build connects LinuxDOOM to the browser through platform code implemented in this repository.

---

## What makes the direct port different?

The direct build starts from the original LinuxDOOM 1.10 code and replaces the OS-specific boundary ourselves:

```text
id Software LinuxDOOM 1.10
          │
          ├── gameplay / renderer / WAD / game state  → original DOOM code
          │
          ├── i_video.c   → browser video/input backend maintained here
          ├── i_system.c  → browser system/timing backend maintained here
          ├── i_sound.c   → browser SFX + direct MUS/WebAudio backend maintained here
          └── i_net.c     → browser/network platform boundary maintained here
                    │
                    ↓
             Emscripten + SDL2
                    ↓
                WebAssembly
                    ↓
                 Browser
```

There is **no doomgeneric or Chocolate Doom layer in the direct build**.

Emscripten is still used as the C → WebAssembly toolchain. SDL2 provides the low-level browser video/input bridge and SDL2_mixer is used for sound-effect mixing. Music does **not** depend on browser MIDI, Timidity, or an external SoundFont: the direct backend parses DOOM MUS data and synthesizes it with WebAudio.

## Current direct-port features

- Original LinuxDOOM 1.10 gameplay and renderer
- WebAssembly browser execution
- Browser video output
- Keyboard, mouse and browser touch/event input
- Single-player gameplay
- DOOM shareware Episode 1 data (`E1M1`–`E1M9`)
- Sound effects
- Direct MUS music synthesis in WebAudio
- Fullscreen control
- Click-to-start audio unlock for browser autoplay policies
- Custom DOOM web shell — no Emscripten demo UI
- Automated reproducible build and GitHub Pages publishing

## Direct audio implementation

The direct port implements the original [`i_sound.h`](https://github.com/id-Software/DOOM/blob/master/linuxdoom-1.10/i_sound.h) interface in this repository rather than importing doomgeneric's sound backend.

### Sound effects

The browser SFX path:

- reads DOOM `DS*` DMX type-3 sound-effect lumps from the WAD
- converts the original 8-bit PCM data for browser playback
- maps DOOM volume and stereo separation to mixer channels
- applies DOOM pitch variation through sample-rate conversion
- mixes the resulting sounds through SDL2_mixer / WebAudio

### Music

The browser music path is now independent of an external MIDI synthesizer:

```text
DOOM WAD D_* music lump
        ↓
original MUS event stream
        ↓
our MUS parser / scheduler
        ↓
program, note, volume, pan, pitch and percussion events
        ↓
our WebAudio oscillator/noise synthesizer
        ↓
🔊 browser audio
```

The implementation preserves DOOM's native **140 Hz MUS timing**, handles channel programs, note velocity, volume, expression, pan, pitch wheel, note release, all-notes-off events, percussion and looping. Instrument families are mapped to lightweight browser oscillator voices, while percussion is synthesized from oscillators/noise. This avoids the missing-MIDI-bank problem that caused music to be silent in the earlier direct build.

Source: [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c)

## Browser platform source

The direct-port implementation is maintained on the [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom) branch.

Key files:

- [`direct-port/i_video_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_video_web.c) — video and browser input boundary
- [`direct-port/i_system_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_system_web.c) — timing/system boundary
- [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c) — DMX SFX + direct MUS/WebAudio music backend
- [`direct-port/i_net_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_net_web.c) — network/platform boundary
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html) — custom DOOM browser UI and click-to-start audio unlock
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web) — Emscripten browser build
- [`direct-port/apply_compat.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/apply_compat.py) — narrow compatibility fixes for building 1997-era C with a modern toolchain
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml) — reproducible CI build and `/direct/` publishing

## Source baseline

- [id Software DOOM source repository](https://github.com/id-Software/DOOM)
- Direct-port baseline commit: [`a77dfb96cb91780ca334d0d4cfd86957558007e0`](https://github.com/id-Software/DOOM/commit/a77dfb96cb91780ca334d0d4cfd86957558007e0)
- Source directory: [`linuxdoom-1.10`](https://github.com/id-Software/DOOM/tree/master/linuxdoom-1.10)
- Toolchain: [Emscripten](https://emscripten.org/) 6.0.5
- Graphics/input bridge: [SDL2](https://github.com/libsdl-org/SDL/tree/SDL2)
- SFX mixer: [SDL2_mixer](https://github.com/libsdl-org/SDL_mixer/tree/SDL2)
- Music output: browser [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)

## Shareware game data

The public demo uses the redistributable DOOM shareware IWAD obtained during CI from SDL's long-standing DOOM archive.

- [SDL DOOM project page](https://www.libsdl.org/projects/doom/)
- [Shareware `doom1.wad.zip`](https://www.libsdl.org/projects/doom/data/doom1.wad.zip)
- Build-verified IWAD size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`

This contains **Episode 1: Knee-Deep in the Dead**, including `E1M1` through secret map `E1M9`.

Commercial DOOM / DOOM II IWADs are **not** distributed by this repository.

## Build pipeline

The direct build is reproducible through GitHub Actions:

```text
GitHub Actions
   ↓
fetch pinned id Software LinuxDOOM source
   ↓
fetch + verify shareware IWAD
   ↓
install our i_video / i_system / i_sound / i_net implementations
   ↓
apply narrow modern-toolchain compatibility fixes
   ↓
Emscripten 6.0.5 + SDL2 + SDL2_mixer + direct WebAudio music synth
   ↓
webdoom.js + webdoom.wasm + webdoom.data + custom HTML shell
   ↓
GitHub Pages /direct/
```

Generated public artifacts can be inspected in [`direct/`](https://github.com/pavy23/web-doom/tree/main/direct).

## Controls

- Arrow keys / configured movement keys: move and turn
- `Ctrl`: fire
- `Space`: use / open
- `Shift`: run
- `1`–`7`: weapon selection
- `Esc`: DOOM menu
- **FULLSCREEN**: browser fullscreen mode
- **RESTART**: reload the game runtime

## Where this can go next

Owning the platform layer makes it possible to evolve the browser port directly rather than waiting for an upstream source port to expose a feature. Candidate directions include:

- richer GM/OPL-style instrument synthesis for closer original music timbre
- HiDPI / widescreen / higher-resolution rendering
- pointer-lock mouse controls
- gamepad and mobile input
- IndexedDB / browser-native save persistence
- spatial audio / HRTF
- WAD and PWAD drag-and-drop
- WebSocket or WebRTC multiplayer
- renderer and gameplay experiments in the original DOOM code itself

## License and attribution

The engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). Refer to the upstream repository and its included license files for the applicable source license and notices.

SDL2 and SDL2_mixer retain their respective licenses and attribution requirements.

The DOOM engine/source license is separate from commercial game data. This repository does not distribute commercial DOOM or DOOM II IWADs.
