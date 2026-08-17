# Web DOOM — Direct LinuxDOOM Browser Port + AI Authoring MCP

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, with a local **MCP authoring plane** that lets AI inspect the live simulation, edit selected level content, playtest immediately, record a ChangeSet, and export the result as a PWAD.

The `/direct/` build starts from the original LinuxDOOM source and replaces the platform-specific `i_*` boundaries for the browser. It does **not** use doomgeneric or Chocolate Doom as the game runtime.

## Play

[▶ **Play the direct WebAssembly port**](https://pavy23.github.io/web-doom/direct/)

Legacy comparison build:

[▶ Earlier doomgeneric-based build](https://pavy23.github.io/web-doom/)

**Current direct-build status:** gameplay, keyboard/mouse/touch input, DMX SFX, Vanilla-style OPL music, live MCP engine control, sector-light authoring, actor spawn/remove journaling and PWAD export are implemented.

## What this project is now

The project started as a direct LinuxDOOM browser port. The current direction is an **AI-native DOOM level-authoring experiment**:

```text
User / AI
   ↓
MCP semantic tools
   ↓
Live LinuxDOOM simulation
   ├── inspect player / enemies / sectors
   ├── edit sector lighting
   ├── spawn / remove actors
   └── playtest immediately
   ↓
Authoring ChangeSet
   ↓
PWAD export
   ↓
play / archive / continue editing
```

The important distinction is that MCP is the **authoring/control interface**; the exported PWAD is the persistent level-content result.

## Architecture

```text
id Software LinuxDOOM 1.10
          │
          ├── gameplay / renderer / WAD / game state → original DOOM code
          ├── i_video.c  → browser video/input backend
          ├── i_system.c → browser timing/system + audio startup
          ├── i_sound.c  → direct DMX SFX backend
          ├── OPL music  → Vanilla-DMX-compatible path + Nuked OPL
          ├── doom_control.c
          │      ├── explicit live state API
          │      ├── actor / sector authoring API
          │      ├── ChangeSet journal
          │      └── PWAD writer
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
                    │
             localhost WebSocket
                    │
                    ↓
              mcp/server.js
                    │
                stdio MCP
                    │
                    ↓
       Claude / Cursor / Codex / Inspector
```

The gameplay and renderer remain LinuxDOOM. Emscripten provides the C-to-WebAssembly toolchain and SDL2 provides the low-level browser platform bridge.

## MCP authoring plane — v0.3

The public GitHub Pages game behaves normally and does **not** connect to localhost. MCP mode is activated by running the local server, which proxies the published `/direct/` build through `127.0.0.1`.

Detailed setup:

[**MCP setup and authoring guide**](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/README.md)

Key source:

- [`mcp/server.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/server.js)
- [`mcp/package.json`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/package.json)
- [`direct-port/doom_control.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_control.c)
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html)

### Quick start

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout direct-linuxdoom
cd mcp
npm install
npm start
```

Open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**. When the bridge is attached the top bar shows **MCP CONNECTED**.

For a real MCP host, configure `mcp/server.js` as a local stdio MCP server instead of running a second `npm start` process.

## Current MCP tools

### Perception / inspection

- `doom_bridge_status` — bridge/play/export-path status
- `doom_get_state` — map, player, current sector, stats and enemy state
- `doom_get_enemies` — nearest/visible enemy queries
- `doom_get_sectors` — floor, ceiling, light, special, tag, approximate origin/distance
- `doom_get_changeset` — inspect current persistent authoring edits

Enemy perception includes canonical names, health, coordinates, player distance, relative angle, LinuxDOOM `P_CheckSight()` line-of-sight and a forward-view `visible` flag.

### Live authoring

- `doom_set_sector_light` — set `0..255` light and journal a `SECTORS` edit
- `doom_spawn_enemy` — spawn Shareware-safe monsters and journal `THINGS` additions
- `doom_remove_nearest_enemy` — remove actors and journal/cancel the corresponding `THINGS` edit
- `doom_export_pwad` — serialize the ChangeSet as a local `.wad`

Shareware-safe spawn types currently include:

```text
zombieman
shotgun_guy
imp
demon
spectre
baron_of_hell
```

### Play/debug-only tools

- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

These intentionally affect only the current playtest and are **not** written into exported level content.

## ChangeSet → PWAD

Version 0.3 introduces persistence.

```text
sector light edit
  → ChangeSet
  → patch SECTORS record

spawn enemy
  → ChangeSet
  → append THINGS record

remove original enemy
  → ChangeSet
  → remove matching THINGS record

remove AI-spawned enemy
  → cancel pending THINGS append
```

The export tool creates a standard PWAD containing the complete current map lump set:

```text
ExMy
THINGS
LINEDEFS
SIDEDEFS
VERTEXES
SEGS
SSECTORS
NODES
SECTORS
REJECT
BLOCKMAP
```

`THINGS` and `SECTORS` are rebuilt/patched from the ChangeSet; the remaining map lumps are copied unchanged. This is possible because the original DOOM source explicitly defines `mapthing_t`, `mapsector_t` and the historical map-lump ordering as its persistent WAD format.

The generated binary is first written inside Emscripten FS, then transferred through the localhost bridge and saved by the Node MCP server under:

```text
mcp/exports/
```

or a directory selected by `DOOM_MCP_EXPORT_DIR`.

Example authoring conversation:

```text
Inspect the room I am standing in.
Make it much darker, around 32.
Remove the nearest visible zombieman.
Spawn three imps farther down the room.
Show me the ChangeSet.
Export this as horror_e1m1.wad.
```

## Current persistence limits

The v0.3 exporter deliberately persists only edits that do not require rebuilding BSP-derived geometry structures:

- sector light changes ✅
- actor spawn/remove ✅
- player cheats/debug state ❌ by design
- floor/ceiling geometry changes ❌
- linedef/door persistence ❌
- vertex/sector topology changes ❌
- texture edits ❌
- multi-map ChangeSets ❌

Topology changes are a later milestone because editing vertices, lines or sector structure can require regeneration of `SEGS`, `SSECTORS`, `NODES`, `REJECT` and `BLOCKMAP` rather than merely patching runtime values.

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

### Music

The current music path no longer uses the earlier WebAudio oscillator approximation.

```text
DOOM MUS + IWAD GENMIDI
        ↓
MUS event conversion
        ↓
Vanilla / DMX-compatible OPL logic
        ↓
OPL register writes
        ↓
Nuked OPL3 v1.8
(OPL2-compatible 9-voice mode)
        ↓
SDL2_mixer post-mix
        ↓
browser audio
```

At build time only the required OPL/MIDI subsystem is imported from pinned Chocolate Doom revision [`410d96855b5df5410ff591a90efeafa889119224`](https://github.com/chocolate-doom/chocolate-doom/commit/410d96855b5df5410ff591a90efeafa889119224). Chocolate Doom is **not** used as the game engine/runtime.

LinuxDOOM baseline: [`a77dfb96cb91780ca334d0d4cfd86957558007e0`](https://github.com/id-Software/DOOM/commit/a77dfb96cb91780ca334d0d4cfd86957558007e0)

## Browser platform source

Development branch:

[`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom)

Key files:

- [`direct-port/i_video_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_video_web.c)
- [`direct-port/i_system_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_system_web.c)
- [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c)
- [`direct-port/doom_control.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_control.c)
- [`direct-port/i_net_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_net_web.c)
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html)
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web)
- [`direct-port/apply_compat.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/apply_compat.py)
- [`direct-port/import_vanilla_opl.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/import_vanilla_opl.py)
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml)

Published build provenance:

[`direct/SOURCE.txt`](https://github.com/pavy23/web-doom/blob/main/direct/SOURCE.txt)

## Shareware game data

The public demo uses the redistributable DOOM shareware IWAD fetched during CI from SDL's long-standing DOOM archive.

Build verification:

- size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`
- `GENMIDI` header: `#OPL_II#`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

## Build pipeline

```text
GitHub Actions
   ↓
fetch pinned LinuxDOOM source
   ↓
fetch + verify shareware IWAD / GENMIDI
   ↓
install browser platform + doom_control authoring layer
   ↓
install/self-test MCP SDK server
   ↓
fetch pinned Vanilla-compatible OPL subsystem
   ↓
compile LinuxDOOM + OPL + MCP authoring API with Emscripten
   ↓
webdoom.js + webdoom.wasm + webdoom.data + custom shell
   ↓
GitHub Pages /direct/
```

## Next authoring milestones

1. door / linedef inspection and safe persistent activation/editing
2. additional sector metadata and texture authoring
3. PWAD import/reload for closed-loop iteration
4. AI playtest scoring and automated revision
5. frame capture / multimodal inspection
6. exact-tic stepping and snapshots for deterministic debugging
7. eventually, original-map generation where geometry/BSP data can be rebuilt safely

## License and attribution

The game engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). The OPL/MIDI compatibility subsystem imported at build time is derived from the pinned [Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom) source revision, including its Nuked OPL integration. Refer to the respective upstream repositories and included notices for applicable terms and attribution.

The MCP server uses the official [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

SDL2 and SDL2_mixer retain their respective licenses and notices.

The DOOM engine/source license is separate from commercial game data. This repository does not distribute commercial DOOM or DOOM II IWADs.
