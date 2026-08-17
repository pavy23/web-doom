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
          ├── i_sound.c   → browser DMX SFX backend maintained here
          ├── OPL bridge  → MUS → GENMIDI → 2-op FM music backend maintained here
          └── i_net.c     → browser/network platform boundary maintained here
                    │
                    ↓
             Emscripten + SDL2
                    ↓
                WebAssembly
                    ↓
                 Browser
```

There is **no doomgeneric or Chocolate Doom runtime layer in the direct build**.

Emscripten is still used as the C → WebAssembly toolchain. SDL2 provides the low-level browser video/input bridge and SDL2_mixer is used for sound-effect mixing. Music does **not** depend on browser MIDI, Timidity, or an external SoundFont: the direct backend parses the original MUS events and uses the IWAD's own `GENMIDI` instrument bank to drive a repository-owned WebAudio FM synthesizer.

## Current direct-port features

- Original LinuxDOOM 1.10 gameplay and renderer
- WebAssembly browser execution
- Browser video output
- Keyboard, mouse and browser touch/event input
- Single-player gameplay
- DOOM shareware Episode 1 data (`E1M1`–`E1M9`)
- Original DMX sound effects
- Direct MUS parsing at DOOM's native 140 Hz timing
- IWAD `GENMIDI`-driven OPL2/AdLib-style music synthesis
- 128 melodic + 47 percussion GENMIDI instruments
- 9-voice OPL2-style voice limit and voice stealing
- Fullscreen control
- Click-to-start audio unlock for browser autoplay policies
- Custom DOOM web shell — no Emscripten demo UI
- Automated reproducible build and GitHub Pages publishing

## Direct audio implementation

The direct port implements the original [`i_sound.h`](https://github.com/id-Software/DOOM/blob/master/linuxdoom-1.10/i_sound.h) boundary in this repository rather than importing doomgeneric's sound backend.

### Sound effects

The browser SFX path:

```text
DOOM WAD DS* lump
        ↓
DMX type-3 parser
        ↓
8-bit PCM → WAV
        ↓
pitch / volume / stereo separation
        ↓
SDL2_mixer
        ↓
WebAudio
```

This preserves the original SFX data and DOOM's pitch variation while adapting it to browser audio.

Source: [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c)

### Music — GENMIDI OPL2-style FM

The previous direct build used a lightweight oscillator/noise synthesizer. The current build goes substantially closer to classic DOOM's AdLib/OPL music path:

```text
DOOM WAD
   ├── D_E1M1 / D_* MUS music data
   └── GENMIDI instrument bank
              │
              ↓
       our MUS parser / scheduler
              │
              ↓
       GENMIDI instrument lookup
              │
              ↓
    modulator + carrier operators
              │
              ↓
       2-operator FM synthesis
              │
              ↓
           WebAudio
              │
              ↓
        🔊 browser audio
```

The public shareware IWAD contains a `GENMIDI` table with **128 melodic instruments and 47 percussion instruments**. The browser FM engine reads that table directly instead of substituting generic instrument-family waveforms.

The synth uses GENMIDI fields including:

- modulator and carrier frequency multipliers
- operator output levels
- attack / decay / sustain / release-style envelope rates
- operator waveform selection
- feedback and FM/additive connection mode
- fixed-note instruments
- per-voice base-note offsets
- second-voice fine tuning
- double-voice instruments
- percussion mapping for notes 35–81

It also models the classic OPL2 **9-voice limit** and steals older voices when the limit is exceeded.

**Accuracy note:** this is an **OPL2/AdLib-style reconstruction using WebAudio FM graphs**, not yet a cycle-accurate or sample-accurate YM3812 chip emulator. The important step here is that the timbre is now driven by DOOM's actual `GENMIDI` instrument definitions rather than hand-picked generic oscillators.

Music source:

- [`direct-port/i_music_opl_bridge.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_music_opl_bridge.c) — LinuxDOOM C ↔ browser music bridge
- [`direct-port/opl_music.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/opl_music.js) — MUS parser, GENMIDI parser and WebAudio 2-operator FM engine

Generated public music engine:

- [`direct/opl_music.js`](https://github.com/pavy23/web-doom/blob/main/direct/opl_music.js)

## Browser platform source

The direct-port implementation is maintained on the [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom) branch.

Key files:

- [`direct-port/i_video_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_video_web.c) — video and browser input boundary
- [`direct-port/i_system_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_system_web.c) — timing/system boundary
- [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c) — DMX SFX and DOOM-facing sound API
- [`direct-port/i_music_opl_bridge.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_music_opl_bridge.c) — C/WebAudio OPL music bridge
- [`direct-port/opl_music.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/opl_music.js) — GENMIDI-driven FM synthesizer
- [`direct-port/i_net_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_net_web.c) — network/platform boundary
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html) — custom DOOM browser UI and click-to-start audio unlock
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web) — Emscripten browser build
- [`direct-port/apply_compat.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/apply_compat.py) — narrow compatibility/platform edits for building 1997-era C with a modern toolchain
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml) — reproducible CI build, GENMIDI validation and `/direct/` publishing

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
- CI additionally verifies that the IWAD includes a valid `#OPL_II#` `GENMIDI` instrument table before building

This contains **Episode 1: Knee-Deep in the Dead**, including `E1M1` through secret map `E1M9`.

Commercial DOOM / DOOM II IWADs are **not** distributed by this repository.

## Build pipeline

The direct build is reproducible through GitHub Actions:

```text
GitHub Actions
   ↓
fetch pinned id Software LinuxDOOM source
   ↓
fetch + verify shareware IWAD + GENMIDI
   ↓
install our i_video / i_system / i_sound / OPL bridge / i_net implementations
   ↓
apply narrow modern-toolchain compatibility/platform edits
   ↓
Emscripten 6.0.5 + SDL2 + SDL2_mixer
   ↓
MUS + GENMIDI → our 2-op FM WebAudio engine
   ↓
webdoom.js + webdoom.wasm + webdoom.data + opl_music.js + custom HTML shell
   ↓
GitHub Pages /direct/
```

Generated public artifacts can be inspected in [`direct/`](https://github.com/pavy23/web-doom/tree/main/direct).

Published provenance details are also available in [`direct/SOURCE.txt`](https://github.com/pavy23/web-doom/blob/main/direct/SOURCE.txt).

## Controls

- Arrow keys / configured movement keys: move and turn
- `Ctrl`: fire
- `Space`: use / open
- `Shift`: run
- `1`–`7`: weapon selection
- `Esc`: DOOM menu
- touch/browser pointer events are supported by the current browser platform layer
- **FULLSCREEN**: browser fullscreen mode
- **RESTART**: reload the game runtime

## Where this can go next

Owning the platform layer makes it possible to evolve the browser port directly rather than waiting for an upstream source port to expose a feature. Candidate directions include:

- cycle/sample-accurate YM3812 / OPL2 emulation, potentially via AudioWorklet/WASM
- HiDPI / widescreen / higher-resolution rendering
- pointer-lock mouse controls
- richer gamepad and mobile controls
- IndexedDB / browser-native save persistence
- spatial audio / HRTF for SFX
- WAD and PWAD drag-and-drop
- WebSocket or WebRTC multiplayer
- renderer and gameplay experiments in the original DOOM code itself

## License and attribution

The engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). Refer to the upstream repository and its included license files for the applicable source license and notices.

SDL2 and SDL2_mixer retain their respective licenses and attribution requirements.

The DOOM engine/source license is separate from commercial game data. This repository does not distribute commercial DOOM or DOOM II IWADs.
