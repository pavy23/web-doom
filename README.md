# Web DOOM — Direct LinuxDOOM Browser Port

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly.

The `/direct/` build starts from the original LinuxDOOM source and replaces the platform-specific `i_*` boundaries for the browser. It does not use doomgeneric or Chocolate Doom as the game runtime.

## Play

### ⭐ Direct LinuxDOOM port — current version

[▶ **Play the direct WebAssembly port**](https://pavy23.github.io/web-doom/direct/)

### Legacy / reference build

[▶ Play the earlier doomgeneric-based build](https://pavy23.github.io/web-doom/)

The legacy root build is kept as a comparison point. The `/direct/` build is the version under active development.

---

## Architecture

```text
id Software LinuxDOOM 1.10
          │
          ├── gameplay / renderer / WAD / game state → original DOOM code
          ├── i_video.c  → browser video/input backend
          ├── i_system.c → browser timing/system backend
          ├── i_sound.c  → direct DMX SFX backend
          ├── OPL music  → Vanilla-DMX-compatible OPL path + Nuked OPL
          └── i_net.c    → browser/network boundary
                    │
                    ↓
           Emscripten + SDL2 + SDL2_mixer
                    │
                    ↓
                 WebAssembly
                    │
                    ↓
                  Browser
```

The gameplay and renderer remain LinuxDOOM. Emscripten is the C → WebAssembly toolchain and SDL2 provides the browser-facing low-level platform bridge.

## Current features

- Original LinuxDOOM 1.10 gameplay and renderer
- WebAssembly browser execution
- Keyboard, mouse and browser event input
- Single-player gameplay
- DOOM shareware Episode 1 (`E1M1`–`E1M9`)
- Original DMX sound-effect data
- DOS-era OPL music path using the IWAD's `GENMIDI` instruments
- Vanilla-DMX-compatible volume, frequency, voice-allocation and percussion behavior
- Nuked OPL3 v1.8 software chip emulation in OPL2-compatible mode by default
- Fullscreen control
- Click-to-start browser audio unlock
- Custom browser shell
- Reproducible GitHub Actions build and GitHub Pages publishing

## Audio implementation

### Sound effects

Sound effects are handled directly by this repository's browser platform layer:

```text
DOOM IWAD DS* lump
        ↓
DMX type-3 parser
        ↓
original 8-bit PCM
        ↓
pitch / volume / stereo separation
        ↓
SDL2_mixer
        ↓
browser audio
```

Source: [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c)

### Music — Vanilla DMX behavior + software OPL chip

The previous browser music implementation approximated OPL instruments with WebAudio oscillators. That approach has been retired because it did not reproduce the original DOS timbre cleanly enough.

The current build uses this path instead:

```text
DOOM D_* MUS lump
        +
IWAD GENMIDI instrument bank
        ↓
MUS → MIDI event conversion
        ↓
Vanilla-Doom / DMX-compatible music logic
        ↓
OPL register writes
        ↓
Nuked OPL3 v1.8
(OPL2-compatible mode, 9 voices by default)
        ↓
signed 16-bit PCM
        ↓
SDL2_mixer post-mix
        ↓
🔊 browser audio
```

At build time the project imports only the required OPL/MIDI subsystem from a **pinned Chocolate Doom 3.1.1 source revision**:

- Chocolate Doom commit: `410d96855b5df5410ff591a90efeafa889119224`
- LinuxDOOM baseline commit: `a77dfb96cb91780ca334d0d4cfd86957558007e0`

Chocolate Doom is **not** used as the game engine/runtime here. Its researched OPL music subsystem is used because it contains compatibility behavior intended to reproduce Vanilla Doom's DMX playback, including:

- nonlinear music-volume mapping
- DOOM/DMX OPL frequency curve
- pitch bend behavior
- nine-voice allocation and voice stealing
- `GENMIDI` melodic/percussion instrument programming
- fixed-pitch and double-voice instruments
- channel priority and historical playback quirks

The resulting OPL register stream is rendered by **Nuked OPL3 v1.8**. With no OPL3 DMX option requested, the music path remains in OPL2-compatible nine-voice mode.

This path does **not** use WebAudio oscillator synthesis, Timidity, browser MIDI, or an external SoundFont.

Relevant implementation files:

- [`direct-port/import_vanilla_opl.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/import_vanilla_opl.py) — prepares the pinned OPL/MIDI subset and LinuxDOOM compatibility boundary
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web) — compiles LinuxDOOM + OPL sources into the browser WASM
- [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c) — SFX-only direct browser backend
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html) — browser UI and audio user-gesture startup

The old `direct-port/opl_music.js` and `direct-port/i_music_opl_bridge.c` paths remain only as **deprecated compatibility stubs** because the existing CI workflow still checks/copies those paths. They are not loaded or compiled by the direct runtime.

### What “original sound” means here

This is much closer to the original **digital DOS-era AdLib/Sound Blaster OPL path** than the previous WebAudio approximation: DOOM's instrument data and DMX-style register behavior ultimately feed a software model of the OPL chip.

It is not an electrical clone of every physical 1993 sound card. Real AdLib/Sound Blaster models and revisions can add their own DAC, low-pass filtering, mixer coloration and analog noise. If a specific historical board recording is the target, that analog output stage is a separate layer to model after the digital OPL path.

## Browser platform source

The direct-port implementation is maintained on the [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom) branch.

Key files:

- [`direct-port/i_video_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_video_web.c) — video/input boundary
- [`direct-port/i_system_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_system_web.c) — timing/system boundary
- [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c) — direct DMX SFX backend
- [`direct-port/import_vanilla_opl.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/import_vanilla_opl.py) — OPL/MIDI import adapter
- [`direct-port/i_net_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_net_web.c) — network boundary
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html) — browser shell
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web) — Emscripten build
- [`direct-port/apply_compat.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/apply_compat.py) — narrow modern-toolchain compatibility edits
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml) — CI build/publish workflow

## Shareware game data

The public demo uses the redistributable DOOM shareware IWAD fetched during CI from SDL's long-standing DOOM archive.

Build verification:

- IWAD size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`
- `GENMIDI` header: `#OPL_II#`

The bundled shareware data contains **Episode 1: Knee-Deep in the Dead**, including secret map `E1M9`.

Commercial DOOM / DOOM II IWADs are **not** distributed by this repository.

## Build pipeline

```text
GitHub Actions
   ↓
fetch pinned id Software LinuxDOOM source
   ↓
fetch + verify shareware IWAD / GENMIDI
   ↓
install browser i_video / i_system / i_sound / i_net
   ↓
fetch pinned Chocolate Doom OPL/MIDI source subset
   ↓
adapt only the music/platform boundary
   ↓
compile LinuxDOOM + DMX-compatible OPL logic + Nuked OPL
   ↓
Emscripten 6.0.5 + SDL2 + SDL2_mixer
   ↓
webdoom.js + webdoom.wasm + webdoom.data + custom HTML shell
   ↓
GitHub Pages /direct/
```

Published provenance is recorded in [`direct/SOURCE.txt`](https://github.com/pavy23/web-doom/blob/main/direct/SOURCE.txt).

## Controls

- Arrow keys / configured movement keys: move and turn
- `Ctrl`: fire
- `Space`: use / open
- `Shift`: run
- `1`–`7`: weapon selection
- `Esc`: DOOM menu
- **FULLSCREEN**: browser fullscreen mode
- **RESTART**: reload the game runtime

## Possible next steps

- compare the emulator output against known real AdLib / Sound Blaster captures
- model a specific board's analog low-pass / DAC / mixer coloration if needed
- HiDPI / widescreen / higher-resolution rendering
- pointer-lock mouse controls
- richer gamepad and mobile controls
- IndexedDB save persistence
- WAD / PWAD drag-and-drop
- WebSocket or WebRTC multiplayer

## License and attribution

The game engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). The OPL/MIDI compatibility subsystem imported at build time is derived from the pinned [Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom) source revision, including its Nuked OPL integration. Refer to the respective upstream repositories and included license notices for applicable terms and attribution.

SDL2 and SDL2_mixer retain their respective licenses and notices.

The DOOM engine/source license is separate from commercial game data. This repository does not distribute commercial DOOM or DOOM II IWADs.
