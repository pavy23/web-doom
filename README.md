# Web DOOM — Direct LinuxDOOM Browser Port + AI Authoring/Playtest MCP

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, plus a local MCP layer that lets AI inspect and edit selected level content, playtest immediately, observe the rendered frame and telemetry, export a real PWAD, reload it as the next baseline, and continue iterating.

The `/direct/` build starts from original LinuxDOOM source and replaces browser-facing platform boundaries. It does **not** use doomgeneric or Chocolate Doom as the game runtime.

## Play

[▶ **Direct LinuxDOOM WebAssembly build**](https://pavy23.github.io/web-doom/direct/)

Legacy comparison build:

[▶ Earlier doomgeneric-based build](https://pavy23.github.io/web-doom/)

## Current direction

The project began as a browser-port experiment. It is now an **AI-native DOOM level-authoring and playtest sandbox**.

```text
User / AI
   ↓
MCP semantic tools
   ↓
Live LinuxDOOM
   ├── inspect player / enemies / sectors / linedefs / materials
   ├── edit lighting / actors / doors / wall + flat materials
   └── playtest immediately
   ↓
Pause / exact world-tic step
   ↓
PNG frame + structured telemetry
   ↓
AI evaluation / revision
   ↓
Authoring ChangeSet
   ↓
PWAD export
   ↓
PWAD reload as next baseline
   ↓
next iteration
```

The roles are deliberately separate:

- **MCP** = AI-facing authoring, execution-control and observation interface
- **PWAD** = persistent playable level artifact
- **LinuxDOOM** = gameplay runtime and validator

Current MCP version: **0.7.0**.

## Architecture

```text
id Software LinuxDOOM 1.10
          │
          ├── original gameplay / renderer / WAD / game state
          ├── browser i_video / i_system / i_sound / i_net
          ├── Vanilla-DMX-compatible OPL music + Nuked OPL
          ├── doom_control.c      state / actors / sector light / ChangeSet / PWAD
          ├── doom_linedefs.c     door + trigger semantics / LINEDEFS
          ├── doom_visuals.c      wall + flat materials / SIDEDEFS + SECTORS
          ├── doom_playtest.c     pause / exact world-tic step / telemetry
          └── doom_reload.c       PWAD validation / W_AddFile / G_InitNew
                    │
                    ↓
           Emscripten + SDL2 + SDL2_mixer
                    │
                    ↓
                 WebAssembly
                    │
                    ↓
                  Browser
             ┌──────┴──────┐
             │             │
     authoring WS      playtest WS
       :3777/control    :3778/playtest
             │             │
             └──────┬──────┘
                    ↓
        mcp/playtest_server.js
                    │
             local stdio MCP
                    │
                    ↓
       Claude / Cursor / Codex / Inspector
```

## MCP quick start

The development source lives on [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom).

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

Click **CLICK TO START**. The top bar shows **MCP CONNECTED** when the authoring bridge attaches. The v0.7 entry point also starts the playtest/vision bridge on port `3778`.

For an MCP host, configure:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/playtest_server.js"]
}
```

Detailed guide:

[**MCP authoring + playtest guide**](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/README.md)

# MCP capabilities

## Inspection

- `doom_bridge_status`
- `doom_get_state`
- `doom_get_enemies`
- `doom_get_sectors`
- `doom_get_linedefs`
- `doom_get_visuals`
- `doom_list_visual_assets`
- `doom_get_changeset`

## Persistent authoring

- `doom_set_sector_light` → `SECTORS`
- `doom_spawn_enemy` / `doom_remove_nearest_enemy` → `THINGS`
- `doom_set_linedef_action` → `LINEDEFS`
- `doom_set_wall_texture` → `SIDEDEFS`
- `doom_set_sector_flat` → `SECTORS`
- `doom_export_pwad`
- `doom_list_exports`
- `doom_load_pwad`
- `doom_reload_current_map`

## v0.7 playtest / vision

- `doom_playtest_status`
- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`

## Playtest/debug helpers

- `doom_activate_linedef`
- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

These helpers affect the live simulation but are not serialized into level content.

# v0.7 — AI Playtest / Vision

v0.7 is the first step away from “add more editing knobs” toward **AI evaluating its own authored result**.

### Pause without stopping the browser

LinuxDOOM already stops world simulation inside `P_Ticker()` when the global `paused` flag is active. The browser port preserves that behavior while keeping the outer browser loop, rendering and MCP connections alive.

### Exact world-tic stepping

A build-time patch makes the existing pause gate accept only explicitly budgeted MCP steps.

```text
paused world
   ↓
doom_step_tics count=N
   ↓
N passes through P_Ticker()
   ↓
step budget = 0
   ↓
return updated telemetry
```

`35` world tics are approximately one second of normal DOOM simulation.

This is deliberately a **world-tic** controller, not a replacement game loop.

### Playtest telemetry

The playtest module tracks a resettable measurement window including:

- actual world tics and elapsed level time
- current / visited sectors
- approximate travel distance
- current and minimum health
- accumulated damage and healing
- deaths
- kills / items / secrets and deltas
- armor and ammunition
- pause and pending-step state

Telemetry samples are updated after real `P_Ticker()` world updates, including exact MCP steps.

### Frame capture for AI vision

`doom_capture_frame` captures the final SDL/Emscripten canvas as PNG and returns it as MCP **image content**, together with matching telemetry.

For a stable observation:

```text
Pause the world.
Capture the frame.
Evaluate visibility, enemy pressure and visual hierarchy using the image and telemetry.
```

# Existing visual / logic authoring

The current bounded authoring surface changes existing geometry semantics and materials only.

Wall textures are validated with original LinuxDOOM `R_CheckTextureNumForName()` before mutation. Floor/ceiling flat names must resolve inside the loaded flat namespace. Linedef actions use allow-listed Vanilla-compatible door presets.

The AI is expected to inspect/list real assets first rather than inventing texture names.

# ChangeSet → PWAD

The exporter writes the full current-map Vanilla lump set:

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

Persistent patches currently cover:

```text
THINGS    actor spawn/remove
LINEDEFS  existing special/tag behavior
SIDEDEFS  top/middle/bottom wall textures
SECTORS   light + floor/ceiling flats
```

The topology/BSP-derived data remains unchanged:

```text
VERTEXES
SEGS
SSECTORS
NODES
REJECT
BLOCKMAP
```

That boundary is deliberate. The project is not pretending that arbitrary geometry mutation is safe without a node/blockmap rebuild pipeline.

# Closed authoring + evaluation loop

```text
inspect
 ↓
edit actors / lighting / doors / materials
 ↓
reset playtest metrics
 ↓
play normally or exact-step
 ↓
pause
 ↓
capture PNG + telemetry
 ↓
evaluate / revise
 ↓
doom_get_changeset
 ↓
doom_export_pwad v1.wad
 ↓
doom_load_pwad v1.wad
 ↓
W_AddFile() → G_InitNew() → P_SetupLevel()
 ↓
v1 becomes fresh baseline
```

LinuxDOOM permits duplicate lump names and searches backward, so later-loaded PWADs naturally override earlier IWAD/PWAD map lumps.

`doom_reload.c` also handles a historical runtime detail: `lumpcache` is allocated at startup while `W_AddFile()` can enlarge the lump directory. The adapter grows/zeros the cache before runtime append.

# Example AI session

```text
Inspect the opening room and its available materials.
Make it darker and more threatening without changing geometry.
Use only wall/flat assets that actually exist in the loaded IWAD.
Add two imps deeper inside and keep the exit door reusable.

Reset playtest metrics and let me test it.

[after test]
Pause the world.
Capture the current frame and telemetry.
Assess whether visibility is too poor or enemy pressure is excessive.
Revise the authored content if needed.

Export the accepted version as horror_e1m1_v5.wad.
Reload that file as the new baseline.
```

# Audio

## Sound effects

```text
DOOM DS* DMX type-3 lump
   ↓
direct parser
   ↓
original 8-bit PCM + pitch/volume/stereo
   ↓
SDL2_mixer
   ↓
browser audio
```

## Music

```text
DOOM MUS + IWAD GENMIDI
   ↓
Vanilla / DMX-compatible OPL behavior
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

Only the required OPL/MIDI subsystem is imported from pinned Chocolate Doom revision [`410d96855b5df5410ff591a90efeafa889119224`](https://github.com/chocolate-doom/chocolate-doom/commit/410d96855b5df5410ff591a90efeafa889119224). Chocolate Doom is **not** the game runtime.

LinuxDOOM baseline: [`a77dfb96cb91780ca334d0d4cfd86957558007e0`](https://github.com/id-Software/DOOM/commit/a77dfb96cb91780ca334d0d4cfd86957558007e0)

# Key source files

- [`direct-port/doom_control.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_control.c)
- [`direct-port/doom_linedefs.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_linedefs.c)
- [`direct-port/doom_visuals.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_visuals.c)
- [`direct-port/doom_playtest.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_playtest.c)
- [`direct-port/playtest_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/playtest_bridge.js)
- [`direct-port/patch_playtest_ticker.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/patch_playtest_ticker.py)
- [`direct-port/doom_reload.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_reload.c)
- [`mcp/server.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/server.js)
- [`mcp/playtest_server.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/playtest_server.js)
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml)

Published provenance:

[`direct/SOURCE.txt`](https://github.com/pavy23/web-doom/blob/main/direct/SOURCE.txt)

# Current limits / next milestone

Implemented:

- bounded actor / light / door / material authoring ✅
- PWAD export/reload ✅
- pause/resume ✅
- exact world-tic stepping ✅
- playtest telemetry ✅
- MCP PNG frame capture ✅

Still intentionally deferred:

- arbitrary vertex/sector topology editing ❌
- BSP/node rebuild ❌
- full new-map generation ❌
- autonomous movement/action playtest agent ❌

The next milestone is **AI input/playtest agency**: bounded movement, turning, use/fire actions and higher-level evaluation so the AI can traverse an authored encounter, measure the result, and decide whether to revise or accept the PWAD.

# Shareware data

The public demo uses redistributable DOOM shareware data fetched during CI from SDL's long-standing archive.

- size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`
- `GENMIDI`: `#OPL_II#`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

# License / attribution

The game engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). The OPL/MIDI compatibility subsystem imported at build time is derived from the pinned [Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom) revision, including Nuked OPL integration. SDL2, SDL2_mixer and the Model Context Protocol TypeScript SDK retain their respective licenses/notices.

The DOOM engine/source license is separate from commercial game data; this repository does not distribute commercial IWADs.
