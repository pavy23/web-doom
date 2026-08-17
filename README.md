# Web DOOM — Direct LinuxDOOM Browser Port + AI Authoring/Playtest MCP

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, plus a local MCP layer that lets AI inspect and edit selected level content, drive bounded deterministic playtests through DOOM's real gameplay-input path, observe rendered frames and telemetry, export a real PWAD, reload it as the next baseline, and continue iterating.

The `/direct/` build starts from original LinuxDOOM source and replaces browser-facing platform boundaries. It does **not** use doomgeneric or Chocolate Doom as the game runtime.

## Play

[▶ **Direct LinuxDOOM WebAssembly build**](https://pavy23.github.io/web-doom/direct/)

Legacy comparison build:

[▶ Earlier doomgeneric-based build](https://pavy23.github.io/web-doom/)

## Current direction

The project began as a browser-port experiment. It is now an **AI-native DOOM level-authoring and autonomous-playtest sandbox**.

```text
User / AI goal
   ↓
MCP semantic inspection
   ↓
Live LinuxDOOM
   ├── edit actors / lighting / doors / materials
   └── persist safe existing-geometry changes
   ↓
short autonomous ticcmd action
   ↓
exact P_Ticker world tics
   ↓
PNG frame + structured telemetry
   ↓
AI evaluation
   ├── next play action
   └── authoring revision
   ↓
ChangeSet → PWAD export
   ↓
PWAD reload as next baseline
   ↓
next iteration
```

The roles are deliberately separate:

- **MCP** = AI-facing authoring, execution-control and observation interface
- **PWAD** = persistent playable level artifact
- **LinuxDOOM** = gameplay runtime and validator

Current MCP version: **0.8.0**.

## Architecture

```text
id Software LinuxDOOM 1.10
          │
          ├── original gameplay / renderer / WAD / game state
          ├── browser i_video / i_system / i_sound / i_net
          ├── Vanilla-DMX-compatible OPL music + Nuked OPL
          ├── doom_control.c       state / actors / sector light / ChangeSet / PWAD
          ├── doom_linedefs.c      door + trigger semantics / LINEDEFS
          ├── doom_visuals.c       wall + flat materials / SIDEDEFS + SECTORS
          ├── doom_playtest.c      pause / exact world-tic step / telemetry
          ├── doom_agent_input.c   bounded console-player ticcmd override
          └── doom_reload.c        PWAD validation / W_AddFile / G_InitNew
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
     authoring WS      playtest/agent WS
       :3777/control       :3778/playtest
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

Click **CLICK TO START**. The authoring bridge attaches on port `3777`; v0.8 also starts the playtest/vision/agent bridge on `3778`.

For an MCP host, configure:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/playtest_server.js"]
}
```

Detailed guide:

[**MCP authoring + autonomous playtest guide**](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/README.md)

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

## Playtest / vision

- `doom_playtest_status`
- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`

## v0.8 autonomous input

- `doom_agent_input_status`
- `doom_cancel_agent_input`
- `doom_run_input`
- `doom_run_input_sequence`

## Debug helpers

- `doom_activate_linedef`
- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

Debug and autonomous-playtest actions affect only the live simulation; they are not serialized into level content.

# v0.8 — deterministic autonomous playtest

v0.8 gives the AI bounded **agency** instead of only observation.

The implementation does not synthesize browser keyboard events. LinuxDOOM first selects the console player's command inside `G_Ticker()`. A narrow build-time hook then overrides only the command that is about to be consumed by gameplay.

```text
G_Ticker()
   ↓
select actual console-player net/demo ticcmd
   ↓
doomctl_apply_agent_ticcmd()
   ↓
players[consoleplayer].cmd
   ↓
P_Ticker()
   ↓
normal DOOM movement / collision / weapons / USE logic
```

The bounded input surface exposes:

```text
forward  -1.0 .. +1.0
strafe   -1.0 .. +1.0
turn     -1.0 .. +1.0
attack   false / true
use      false / true
tics     1 .. 350
```

Movement stays within original DOOM command magnitudes: full forward maps to 50 ticcmd units, full strafe to 40 and full turn to the original fast keyboard-turn magnitude.

The agent never synthesizes `BT_SPECIAL`, save, pause or weapon-change commands through this path.

## Exact action lifetime

Autonomous-input lifetime is tied to **actual world simulation**, not browser frames or prebuilt networking commands.

```text
queued AI input
   ↓
exact world step permitted
   ↓
P_Ticker completes
   ↓
telemetry sampled
   ↓
agent input lifetime -1
```

A paused browser can therefore render, answer MCP calls and capture frames forever without consuming a queued action.

`doom_run_input` composes one input with the v0.7 exact-step controller, then leaves the world paused for deterministic inspection.

Example conceptual request:

```json
{
  "forward": 1,
  "turn": 0.25,
  "attack": true,
  "use": false,
  "tics": 35,
  "captureAfter": true
}
```

That means: apply the bounded input for exactly 35 actual DOOM world tics, then return the resulting frame and telemetry.

`doom_run_input_sequence` executes up to 16 short actions, with a 700-world-tic total request cap and early stop on player death. It is intended for short tactical/navigation plans rather than blind full-level scripting.

# Playtest vision and telemetry

`doom_capture_frame` captures the final SDL/Emscripten canvas as PNG and returns it as MCP **image content**, together with matching telemetry.

Telemetry tracks a resettable measurement window including:

- actual world tics and elapsed level time
- current / visited sectors
- approximate travel distance
- current and minimum health
- damage and healing
- deaths
- kills / items / secrets and deltas
- armor and ammunition
- pause and pending-step state

A useful autonomous loop is deliberately short-horizon:

```text
inspect frame/state
 ↓
run 5–70 tics of movement/combat/use
 ↓
frame + telemetry
 ↓
check progress / damage / enemies / collision
 ↓
choose next short action
```

For example, substantial forward input with almost no increase in `distanceUnits` is a useful signal that the agent may be blocked and should turn, inspect or try `use` rather than continue pushing forward blindly.

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

That boundary is deliberate. The project does not pretend arbitrary geometry mutation is safe without a node/blockmap rebuild pipeline.

# Closed authoring + autonomous evaluation loop

```text
inspect
 ↓
edit actors / lighting / doors / materials
 ↓
reset playtest metrics
 ↓
short deterministic autonomous actions
 ↓
PNG + telemetry after each observation point
 ↓
evaluate progress / survivability / visibility / pressure
 ↓
continue playtest OR revise content
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
Inspect the opening encounter and capture the current frame.
Make it darker and more threatening without changing geometry.
Use only wall/flat assets that exist in the IWAD.
Add two imps deeper inside and keep the exit door usable.

Reset playtest metrics.
Now playtest it yourself in short actions.
After every useful observation point, use the frame and telemetry to decide
whether to move, turn, attack, use a door, or revise the map.

If the opening encounter is too punishing or visibility is too poor,
change the authored content and test again.

Export the accepted version as horror_e1m1_v6.wad and reload it as baseline.
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
Nuked OPL3 v1.8 (OPL2-compatible 9-voice mode)
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
- [`direct-port/doom_agent_input.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_agent_input.c)
- [`direct-port/playtest_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/playtest_bridge.js)
- [`direct-port/agent_input_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/agent_input_bridge.js)
- [`direct-port/patch_playtest_ticker.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/patch_playtest_ticker.py)
- [`direct-port/patch_agent_input.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/patch_agent_input.py)
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
- pause/resume + exact world-tic stepping ✅
- playtest telemetry ✅
- MCP PNG frame capture ✅
- bounded deterministic movement / turn / fire / use ✅
- short autonomous input sequences ✅

Still intentionally deferred:

- arbitrary vertex/sector topology editing ❌
- BSP/node rebuild ❌
- full new-map generation ❌
- built-in design-goal scoring / acceptance policy ❌

The next milestone is **v0.9 — Design Goal / Automated Evaluation**: turn telemetry and visual observations into explicit criteria for survivability, progress, encounter pressure, visibility and stuck detection so an AI can decide whether an authored PWAD should be revised or accepted.

# Shareware data

The public demo uses redistributable DOOM shareware data fetched during CI from SDL's long-standing archive.

- size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`
- `GENMIDI`: `#OPL_II#`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

# License / attribution

The game engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). The OPL/MIDI compatibility subsystem imported at build time is derived from the pinned [Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom) revision, including Nuked OPL integration. SDL2, SDL2_mixer and the Model Context Protocol TypeScript SDK retain their respective licenses/notices.

The DOOM engine/source license is separate from commercial game data; this repository does not distribute commercial IWADs.