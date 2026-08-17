# Web DOOM — Direct LinuxDOOM Browser Port + AI Authoring MCP

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, plus a local **MCP authoring plane** that lets AI inspect a live DOOM simulation, edit selected level content, playtest immediately, persist those edits as a PWAD, and load the PWAD back as the next authoring baseline.

The `/direct/` build starts from the original LinuxDOOM source and replaces browser-facing platform boundaries. It does **not** use doomgeneric or Chocolate Doom as the game runtime.

## Play

[▶ **Play the direct WebAssembly port**](https://pavy23.github.io/web-doom/direct/)

Legacy comparison build:

[▶ Earlier doomgeneric-based build](https://pavy23.github.io/web-doom/)

**Current direct-build status:** gameplay, keyboard/mouse/touch input, DMX SFX, Vanilla-style OPL music, live MCP state/actor/sector control, ChangeSet journaling, PWAD export, and runtime PWAD reload are implemented.

# What this project is now

The project began as a direct LinuxDOOM browser port. The current direction is an **AI-native DOOM level-authoring experiment**.

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
local .wad
   ↓
PWAD reload
   ↓
LinuxDOOM native map rebuild
   ↓
fresh ChangeSet
   ↓
next AI iteration
```

The important distinction is:

- **MCP** is the AI-facing authoring/control interface.
- **PWAD** is the persistent level-content artifact.
- **LinuxDOOM** remains the runtime and validator for the actual gameplay world.

Version **0.4** closes the first full `inspect → edit → playtest → export → reload → edit again` loop.

# Architecture

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
          ├── doom_reload.c
          │      ├── PWAD validation
          │      ├── runtime lumpcache growth
          │      ├── W_AddFile() override append
          │      └── G_InitNew() map rebuild
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
       local exports/ + stdio MCP
                    │
                    ↓
       Claude / Cursor / Codex / Inspector
```

The gameplay and renderer remain LinuxDOOM. Emscripten is the C-to-WebAssembly toolchain; SDL2 supplies the low-level browser platform bridge.

# MCP authoring plane — v0.4

The public GitHub Pages game behaves normally and does **not** connect to localhost. MCP mode runs through a local proxy at `127.0.0.1`.

Detailed setup:

[**MCP setup and authoring guide**](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/README.md)

Key source:

- [`mcp/server.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/server.js)
- [`mcp/package.json`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/package.json)
- [`direct-port/doom_control.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_control.c)
- [`direct-port/doom_reload.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_reload.c)
- [`direct-port/authoring_reload_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/authoring_reload_bridge.js)
- [`direct-port/patch_control_reload.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/patch_control_reload.py)
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html)

## Quick start

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

Click **CLICK TO START**. The top bar shows **MCP CONNECTED** when attached.

For an MCP host, configure `mcp/server.js` as a local stdio MCP server instead of launching a second server on the same port.

# Current MCP tools

## Perception / inspection

- `doom_bridge_status` — bridge, MCP version, play URL and export directory
- `doom_get_state` — map/player/current-sector/stats/enemy state
- `doom_get_enemies` — nearest/visible enemy queries
- `doom_get_sectors` — floor, ceiling, light, special, tag and approximate sector distance
- `doom_get_changeset` — persistent edits made since the current baseline was loaded

Enemy perception includes canonical name, health, coordinates, player distance, relative angle, LinuxDOOM `P_CheckSight()` and a forward-view `visible` flag.

## Persistent authoring

- `doom_set_sector_light` — journal a `SECTORS` light edit
- `doom_spawn_enemy` — journal `THINGS` additions
- `doom_remove_nearest_enemy` — journal/cancel `THINGS` entries
- `doom_export_pwad` — save the ChangeSet as a real `.wad`
- `doom_list_exports` — list locally exported iterations
- `doom_load_pwad` — load an exported PWAD as the new runtime/authoring baseline
- `doom_reload_current_map` — discard live edits and reconstruct from the latest already-loaded baseline

Shareware-safe spawn types currently include:

```text
zombieman
shotgun_guy
imp
demon
spectre
baron_of_hell
```

## Play/debug-only

- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

These deliberately affect only the playtest session and are **not** serialized into level content.

# ChangeSet → PWAD

Current persistence works like this:

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

The exporter writes a standard PWAD containing the complete current map lump set:

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

`THINGS` and `SECTORS` are rebuilt/patched; the remaining map lumps are copied unchanged.

The C engine first writes the PWAD inside Emscripten FS. Browser JavaScript transfers the binary over the localhost bridge, and the Node MCP server stores it under:

```text
mcp/exports/
```

or a folder selected through `DOOM_MCP_EXPORT_DIR`.

# PWAD reload — the closed loop

Version 0.4 adds the missing half of persistence: **the generated WAD can become the next live baseline without restarting the browser page.**

```text
v1 ChangeSet
   ↓
doom_export_pwad
   ↓
horror_e1m1_v1.wad
   ↓
doom_load_pwad
   ↓
Node + C validation
   ↓
Emscripten FS
   ↓
W_AddFile()
   ↓
new PWAD overrides IWAD / older PWAD lumps
   ↓
G_InitNew()
   ↓
P_SetupLevel()
   ↓
map starts again using v1 content
   ↓
ChangeSet = empty
   ↓
start v2 edits
```

This uses LinuxDOOM's original WAD rule: duplicate lump names are legal and lookup scans backward, so **later-loaded files override earlier data**.

There is one historical runtime issue to solve. LinuxDOOM's `W_InitMultipleFiles()` allocates `lumpcache` only once at startup, while `W_AddFile()` can enlarge `lumpinfo`. A naive runtime append would therefore allow new lump indices to run beyond the cache allocation.

`doom_reload.c` handles this by validating the incoming PWAD/lump count, growing `lumpcache` before `W_AddFile()`, zeroing the new slots, and only then restarting the map.

PWAD imports are capped at **32 per browser session**, because the original WAD architecture retains appended file handles/directories and does not provide a modern unload mechanism.

## Protecting unexported changes

`doom_load_pwad` and `doom_reload_current_map` inspect the current ChangeSet first. If edits are pending they refuse by default.

After exporting, the author/AI can explicitly accept replacement of the current live ChangeSet:

```json
{
  "filename": "horror_e1m1_v1.wad",
  "discardChanges": true
}
```

After a successful import, the ChangeSet is reset because the imported PWAD itself now contains those edits.

# Example end-to-end authoring conversation

```text
Inspect the room I am standing in.
Make the current sector light 32.
Remove the nearest visible zombieman.
Spawn three imps deeper into the room.

Let me play it.

Show me the ChangeSet.
Export it as horror_e1m1_v1.wad.
List our exported PWADs.
Load horror_e1m1_v1.wad as the new baseline and discard the just-exported live changes.

Now inspect the level again.
Make the next room slightly brighter and export v2.
```

That is the first usable miniature version of an **AI content-authoring pipeline** rather than an AI-controlled game demo.

# Current persistence limits

v0.4 intentionally persists only edits that do not require rebuilding BSP/topology structures:

- sector light changes ✅
- actor spawn/remove ✅
- PWAD export ✅
- PWAD reload / iterative baseline ✅
- player cheats/debug state ❌ by design
- floor/ceiling geometry changes ❌
- persistent linedef/door edits ❌
- vertex/sector topology changes ❌
- texture edits ❌
- multi-map ChangeSets ❌

Topology edits can require regeneration of `SEGS`, `SSECTORS`, `NODES`, `REJECT` and `BLOCKMAP`, so they should not be treated as simple runtime memory changes.

# Audio implementation

## Sound effects

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

## Music

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

At build time only the required OPL/MIDI subsystem is imported from pinned Chocolate Doom revision [`410d96855b5df5410ff591a90efeafa889119224`](https://github.com/chocolate-doom/chocolate-doom/commit/410d96855b5df5410ff591a90efeafa889119224). Chocolate Doom is **not** the game runtime.

LinuxDOOM baseline: [`a77dfb96cb91780ca334d0d4cfd86957558007e0`](https://github.com/id-Software/DOOM/commit/a77dfb96cb91780ca334d0d4cfd86957558007e0)

# Browser / build source

Development branch:

[`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom)

Key files:

- [`direct-port/i_video_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_video_web.c)
- [`direct-port/i_system_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_system_web.c)
- [`direct-port/i_sound_web.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/i_sound_web.c)
- [`direct-port/doom_control.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_control.c)
- [`direct-port/doom_reload.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_reload.c)
- [`direct-port/authoring_reload_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/authoring_reload_bridge.js)
- [`direct-port/patch_control_reload.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/patch_control_reload.py)
- [`direct-port/shell.html`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/shell.html)
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web)
- [`direct-port/import_vanilla_opl.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/import_vanilla_opl.py)
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml)

Published provenance:

[`direct/SOURCE.txt`](https://github.com/pavy23/web-doom/blob/main/direct/SOURCE.txt)

# Shareware game data

The public demo uses the redistributable DOOM shareware IWAD fetched during CI from SDL's long-standing DOOM archive.

Build verification:

- size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`
- `GENMIDI` header: `#OPL_II#`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

# Build pipeline

```text
GitHub Actions
   ↓
fetch pinned LinuxDOOM source
   ↓
fetch + verify shareware IWAD / GENMIDI
   ↓
install browser platform + authoring + reload layer
   ↓
install/self-test MCP SDK server
   ↓
fetch pinned Vanilla-compatible OPL subsystem
   ↓
compile LinuxDOOM + OPL + authoring/reload API with Emscripten
   ↓
webdoom.js + webdoom.wasm + webdoom.data + custom shell
   ↓
GitHub Pages /direct/
```

# Next authoring milestones

With export/reload closed, the next step is no longer “make persistence work.” It is to expand what the AI can author safely:

1. **existing door / linedef inspection and persistent control**
2. safe `LINEDEFS` / `SIDEDEFS` metadata edits that do not require BSP rebuild
3. AI playtest evaluation and revision suggestions
4. frame capture / multimodal inspection
5. exact-tic stepping and deterministic snapshots
6. eventually geometry generation plus node/blockmap rebuild tooling

# License and attribution

The game engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). The OPL/MIDI compatibility subsystem imported at build time is derived from the pinned [Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom) revision, including Nuked OPL integration. Refer to upstream repositories and notices for applicable terms.

The MCP server uses the official [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

SDL2 and SDL2_mixer retain their respective licenses and notices.

The DOOM engine/source license is separate from commercial game data. This repository does not distribute commercial DOOM or DOOM II IWADs.
