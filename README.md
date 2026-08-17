# Web DOOM — Direct LinuxDOOM Browser Port

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, with an experimental **MCP control plane** for reading and modifying a live DOOM simulation from AI clients.

The `/direct/` build starts from the original LinuxDOOM source and replaces the platform-specific `i_*` boundaries for the browser. It does not use doomgeneric or Chocolate Doom as the game runtime.

## Play

### ⭐ Direct LinuxDOOM port — current version

[▶ **Play the direct WebAssembly port**](https://pavy23.github.io/web-doom/direct/)

**Current status:** gameplay, DMX sound effects, Vanilla-style OPL music, keyboard/mouse/touch input and the MCP-ready engine control surface are working in the published build.

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
          ├── i_system.c → browser timing/system + audio startup
          ├── i_sound.c  → direct DMX SFX backend
          ├── OPL music  → Vanilla-DMX-compatible OPL path + Nuked OPL
          ├── doom_control.c → explicit live engine-control API
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
- Keyboard, mouse, touch and browser pointer/event input
- Single-player gameplay
- DOOM shareware Episode 1 (`E1M1`–`E1M9`)
- Original DMX sound-effect data
- DOS-era OPL music using the IWAD's `GENMIDI` instruments
- Vanilla-DMX-compatible volume, frequency, voice-allocation and percussion behavior
- Nuked OPL3 v1.8 software chip emulation in OPL2-compatible nine-voice mode by default
- Correct browser audio startup order: SDL/SFX mixer first, OPL music backend second
- Restored Vanilla-style `0..15 → ×8 → internal volume` scaling for music and SFX
- Fullscreen control
- Click-to-start browser audio unlock
- Custom browser shell — no Emscripten demo UI
- Explicit live engine-control API compiled into WASM
- Local MCP 0.2 control plane for AI queries and bounded world mutation
- Reproducible GitHub Actions build and GitHub Pages publishing

# MCP control plane

The MCP layer connects a local AI client to a **live running DOOM engine**, rather than simply displaying DOOM inside an MCP-capable UI.

```text
Claude / Cursor / Codex / MCP Inspector
                 │
                 │ stdio MCP
                 ▼
          mcp/server.js
          ├── MCP tools
          ├── localhost HTTP proxy
          └── WebSocket /control
                 │
                 ▼
          browser shell
                 │
          window.DoomControl
                 │
          Emscripten ccall
                 │
                 ▼
        doom_control.c
                 │
                 ▼
       live LinuxDOOM state
```

The public GitHub Pages game behaves normally and does **not** connect to localhost. MCP mode is activated by running the local server, which proxies the published game through `127.0.0.1` so the browser and control WebSocket share the same local origin.

### Current MCP tools — v0.2

- `doom_bridge_status` — check whether a live browser is attached
- `doom_get_state` — read map/player/enemy state
- `doom_get_enemies` — nearest-first enemy query with visibility/distance filters
- `doom_heal` — heal the current player, capped at 200
- `doom_give_ammo` — give bullets, shells, cells or rockets while respecting max ammo
- `doom_teleport` — collision-aware player movement through LinuxDOOM `P_TeleportMove()`
- `doom_spawn_enemy` — spawn Episode-1-safe enemies in front of the player
- `doom_remove_nearest_enemy` — remove the nearest enemy, optionally only if currently visible

`doom_get_state` now exposes enemy semantics as well as raw actor state:

- canonical enemy name and original numeric type
- health and x/y/z
- distance from the player
- relative angle from the player's view direction
- `lineOfSight` from LinuxDOOM `P_CheckSight()`
- `visible` = line-of-sight plus the forward 90-degree view cone

The public Shareware build intentionally limits MCP spawning to assets guaranteed by Episode 1: `zombieman`, `shotgun_guy`, `imp`, `demon`, `spectre`, and `baron_of_hell`.

Spawns use `P_SpawnMobj()` and are validated with `P_CheckPosition()`. Blocked requested positions are discarded. Removal uses `P_RemoveMobj()`. This keeps actor creation/removal inside the original thinker, collision and world-linking systems instead of writing arbitrary coordinates into WASM memory.

The bridge intentionally does **not** expose arbitrary WASM memory. JavaScript can only invoke functions explicitly exported by [`direct-port/doom_control.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_control.c).

### Try the MCP server

The MCP source is maintained on the [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom) branch.

- [MCP setup and usage guide](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/README.md)
- [`mcp/server.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/server.js)
- [`mcp/package.json`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/package.json)

Basic setup:

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout direct-linuxdoom
cd mcp
npm install
npm start
```

Then open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**. When the local browser bridge attaches, the top bar shows **MCP CONNECTED**.

Example AI intents after connecting an MCP host:

```text
Which enemies can I see right now?
Spawn three imps in front of me.
Remove the nearest visible enemy.
```

For an MCP host, configure `mcp/server.js` as a local stdio MCP server using Node.js 20 or newer. The server uses the current official `@modelcontextprotocol/server` package and the stdio server entry point.

## Audio implementation

### Sound effects

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

The earlier browser implementation approximated OPL instruments with WebAudio oscillators. That path has been retired.

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

At build time the project imports only the required OPL/MIDI subsystem from a pinned Chocolate Doom source revision:

- Chocolate Doom: [`410d96855b5df5410ff591a90efeafa889119224`](https://github.com/chocolate-doom/chocolate-doom/commit/410d96855b5df5410ff591a90efeafa889119224)
- LinuxDOOM baseline: [`a77dfb96cb91780ca334d0d4cfd86957558007e0`](https://github.com/id-Software/DOOM/commit/a77dfb96cb91780ca334d0d4cfd86957558007e0)

Chocolate Doom is **not** used as the game engine/runtime. Its researched OPL subsystem supplies Vanilla/DMX-compatible behavior such as nonlinear volume mapping, frequency/pitch behavior, nine-voice allocation, `GENMIDI` programming, percussion and historical playback quirks. Nuked OPL3 v1.8 then renders the resulting OPL register stream.

This music path does not use WebAudio oscillator synthesis, Timidity, browser MIDI or an external SoundFont.

### Browser audio startup

LinuxDOOM's Unix target did not provide real music playback, so its original platform startup only called `I_InitSound()`.

The browser port explicitly uses:

```text
I_InitSound()
    ↓
SDL2_mixer opens signed 16-bit stereo output
    ↓
I_InitMusic()
    ↓
Vanilla DMX / Nuked OPL backend registers its post-mix callback
```

Shutdown runs in reverse ownership order.

Source: [`direct-port/i_system_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_system_web.c)

### Restored DOS/Vanilla volume scaling

The direct port restores the old DOS-style handoff that remains commented in LinuxDOOM's Unix source:

```text
DOOM menu volume: 0..15
        ↓ ×8
internal audio volume: 0..120
        ↓
DMX-compatible volume mapping
```

These narrow compatibility edits are reproducible in [`direct-port/apply_compat.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/apply_compat.py).

## Browser platform source

The direct implementation is maintained on the [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom) branch.

Key files:

- [`direct-port/i_video_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_video_web.c) — video/input boundary
- [`direct-port/i_system_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_system_web.c) — timing/system/audio-init boundary
- [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c) — direct DMX SFX backend
- [`direct-port/doom_control.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_control.c) — MCP-ready engine state/control API
- [`direct-port/import_vanilla_opl.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/import_vanilla_opl.py) — OPL/MIDI import adapter
- [`direct-port/i_net_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_net_web.c) — network boundary
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html) — browser shell, audio unlock and localhost MCP bridge
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web) — Emscripten build
- [`direct-port/apply_compat.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/apply_compat.py) — narrow compatibility edits
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml) — CI build/publish workflow

## Shareware game data

The public demo uses the redistributable DOOM shareware IWAD fetched during CI from SDL's long-standing DOOM archive.

Build verification:

- IWAD size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`
- `GENMIDI` header: `#OPL_II#`

The bundled data contains **Episode 1: Knee-Deep in the Dead**, including secret map `E1M9`.

Commercial DOOM / DOOM II IWADs are **not** distributed by this repository.

## Build pipeline

```text
GitHub Actions
   ↓
fetch pinned id Software LinuxDOOM source
   ↓
fetch + verify shareware IWAD / GENMIDI
   ↓
install browser platform layer + doom_control.c
   ↓
validate MCP server + official SDK import
   ↓
restore narrow LinuxDOOM / Vanilla compatibility behavior
   ↓
fetch pinned Chocolate Doom OPL/MIDI subset
   ↓
compile LinuxDOOM + DMX-compatible OPL + Nuked OPL + control API
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
- touch/browser pointer input is supported
- **FULLSCREEN**: browser fullscreen mode
- **RESTART**: reload the game runtime

## Next MCP milestones

Completed foundation:

- ✅ readable enemy type decoding
- ✅ nearest / visible enemy queries
- ✅ spawn / remove actors through original engine functions

Next useful steps:

1. inspect and modify sector light/floor/ceiling properties
2. activate doors and linedefs
3. pause and advance the simulation by exact tics
4. save/restore simulation snapshots
5. capture frames for multimodal AI inspection
6. inspect/load WAD and PWAD content through MCP

## License and attribution

The game engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). The OPL/MIDI compatibility subsystem imported at build time is derived from the pinned [Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom) source revision, including its Nuked OPL integration. Refer to the respective upstream repositories and included license notices for applicable terms and attribution.

The MCP server uses the official [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

SDL2 and SDL2_mixer retain their respective licenses and notices.

The DOOM engine/source license is separate from commercial game data. This repository does not distribute commercial DOOM or DOOM II IWADs.
