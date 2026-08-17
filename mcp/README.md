# Web DOOM MCP — Authoring + AI Playtest

This directory contains the local MCP layer for the direct LinuxDOOM WebAssembly port.

Current MCP version: **0.7.0**.

v0.6 completed the bounded authoring surface over existing geometry. v0.7 changes the direction of the project: AI can now **observe and measure the result it authored**, not only mutate it.

```text
AI goal
  ↓
inspect live DOOM
  ↓
edit actors / lighting / doors / materials
  ↓
playtest
  ↓
pause world
  ↓
PNG frame + telemetry
  ↓
exact world-tic stepping when needed
  ↓
evaluate / revise
  ↓
PWAD export + reload
  ↓
next iteration
```

## Setup

Requirements: Node.js 20+, npm and an MCP client (or MCP Inspector).

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

Click **CLICK TO START**. The normal authoring bridge uses `127.0.0.1:3777/control`; v0.7 also opens a dedicated local playtest/vision bridge at `127.0.0.1:3778/playtest`.

For an MCP host, configure the v0.7 entry point:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/playtest_server.js"]
}
```

`npm start` already launches this entry point. Do not separately launch `server.js` on the same authoring port.

# v0.7 playtest / vision tools

## `doom_playtest_status`

Reports whether the dedicated playtest/vision browser bridge is attached.

## `doom_pause_playtest`

Pauses **world simulation** while the browser render/event loop and MCP connections remain alive.

LinuxDOOM already gates world updates inside `P_Ticker()` when `paused` is true. The browser build adds a narrow step hook to that existing gate rather than replacing the game loop.

## `doom_resume_playtest`

Resumes normal real-time world simulation and clears any unused step budget.

## `doom_step_tics`

While paused, advances exactly the requested number of `P_Ticker()` world tics.

```text
35 world tics ≈ 1 second of normal DOOM simulation
```

The MCP tool waits until the exact step budget has been consumed before returning telemetry.

Example:

```text
Pause the playtest.
Advance exactly 35 tics.
Capture the frame and tell me what changed.
```

## `doom_get_playtest_telemetry`

Returns a resettable measurement window containing:

- world tics and elapsed level time
- current / visited sector count
- approximate movement distance
- current and minimum health
- accumulated damage and healing
- deaths
- kills / items / secrets and deltas
- armor
- current ammunition
- pause / pending-step state

Telemetry is sampled after **actual P_Ticker world updates**, including exact MCP steps.

## `doom_reset_playtest_metrics`

Starts a new measurement baseline without changing level content.

Use this before a controlled playtest pass:

```text
Reset playtest metrics.
Resume and let me play the opening encounter.
```

## `doom_capture_frame`

Captures the final SDL/Emscripten browser canvas as PNG and returns it as MCP **image content**, together with matching telemetry.

The captured image is the composed frame the human player sees, including the 3D view and normal DOOM overlays/status presentation.

For deterministic observation, pause first:

```text
Pause the world.
Capture the current frame.
Evaluate visibility, visual hierarchy and enemy pressure using the image plus telemetry.
```

# Existing authoring tools

v0.7 retains all previous authoring functionality.

Inspection:

- `doom_get_state`
- `doom_get_enemies`
- `doom_get_sectors`
- `doom_get_linedefs`
- `doom_get_visuals`
- `doom_list_visual_assets`
- `doom_get_changeset`

Persistent mutations:

- `doom_set_sector_light` → `SECTORS`
- `doom_spawn_enemy` / `doom_remove_nearest_enemy` → `THINGS`
- `doom_set_linedef_action` → `LINEDEFS`
- `doom_set_wall_texture` → `SIDEDEFS`
- `doom_set_sector_flat` → `SECTORS`

Persistence / iteration:

- `doom_export_pwad`
- `doom_list_exports`
- `doom_load_pwad`
- `doom_reload_current_map`

Playtest-only helpers:

- `doom_activate_linedef`
- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

# Architecture

```text
MCP client
   │ stdio
   ▼
playtest_server.js  (v0.7 entry)
   ├── imports all authoring tools from server.js
   ├── pause / resume / exact step
   ├── telemetry
   └── MCP image frame capture
       │
       ├──────── authoring WebSocket :3777/control
       │
       └──────── playtest WebSocket  :3778/playtest
                         │
                         ▼
                  Browser / DoomControl
                         │
                Emscripten ccall + canvas
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
 doom_control.c    authoring modules   doom_playtest.c
 actors/sector     linedef/visual      pause/step/metrics
 PWAD/ChangeSet                           │
       └─────────────────┬────────────────┘
                         ▼
                    LinuxDOOM
                         │
                         ▼
               original P_Ticker()
```

The public GitHub Pages build does not connect to localhost when opened normally. Local bridges activate only when the game is loaded through the local MCP proxy.

# Recommended AI evaluation loop

A useful v0.7 session is:

```text
1. Inspect current room, enemies, doors and materials.
2. Apply a bounded design change.
3. Reset playtest metrics.
4. Play normally or use controlled tic stepping.
5. Pause.
6. Capture frame + telemetry.
7. Evaluate readability / pressure / damage / traversal.
8. Revise authoring changes.
9. Repeat observation.
10. Export the accepted result as PWAD.
11. Reload it as the next baseline.
```

Example:

```text
Make the opening room darker and more threatening without changing geometry.
Use only assets that actually exist in the IWAD.
Add two imps deeper in the room and keep the first encounter survivable.

Reset the playtest metrics and let me test it.

[after test]
Pause the world, capture the frame and inspect the telemetry.
If visibility is too poor or the encounter is too punishing, revise it.
Then export the accepted version as horror_e1m1_v5.wad.
```

# Persistence boundary

The playable artifact remains a normal PWAD. Current persistent map edits rewrite only safe existing-geometry records:

```text
THINGS    actor placement
LINEDEFS  existing special / tag behavior
SIDEDEFS  wall textures
SECTORS   light + floor/ceiling flats
```

`VERTEXES`, `SEGS`, `SSECTORS`, `NODES`, `REJECT` and `BLOCKMAP` remain unchanged.

The project still deliberately avoids arbitrary geometry generation until a real node/blockmap rebuild pipeline is introduced.

# What v0.7 does not yet do

The AI can **observe** a frame and telemetry, but it does not yet autonomously drive a complete level from start to exit. The next milestone is a higher-level playtest agent/input layer that can perform controlled movement/actions, evaluate design goals, and decide when to revise or accept the authored PWAD.
