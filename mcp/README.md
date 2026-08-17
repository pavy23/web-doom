# Web DOOM MCP — Authoring + Autonomous AI Playtest

This directory contains the local MCP layer for the direct LinuxDOOM WebAssembly port.

Current MCP version: **0.8.0**.

v0.6 completed bounded authoring over existing geometry. v0.7 added frame capture, exact world-tic stepping and telemetry. v0.8 closes the next gap: AI can now **drive the original DOOM player through the real `ticcmd_t` gameplay input path** and observe the result.

```text
AI goal
  ↓
inspect / author map
  ↓
reset metrics
  ↓
short autonomous input action
  ↓
exact P_Ticker world tics
  ↓
PNG frame + telemetry
  ↓
evaluate navigation / combat / readability
  ↓
next action or authoring revision
  ↓
PWAD export + reload
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

Open `http://127.0.0.1:3777/` and click **CLICK TO START**.

- authoring bridge: `127.0.0.1:3777/control`
- playtest / vision / agent bridge: `127.0.0.1:3778/playtest`

For an MCP host:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/playtest_server.js"]
}
```

`npm start` already launches the v0.8 entry point.

# v0.8 autonomous input

## `doom_run_input`

Runs one deterministic action for exactly N real world tics. The tool pauses the world if needed, queues a bounded console-player command, advances the exact step budget and leaves the world paused for inspection.

Inputs:

```text
forward  -1.0 .. +1.0   backward .. forward
strafe   -1.0 .. +1.0   left .. right
turn     -1.0 .. +1.0   left .. right
attack   false / true
use      false / true
tics     1 .. 350
```

Example:

```text
Move forward at full speed while turning slightly right for 35 tics.
Capture the resulting frame.
```

Equivalent conceptual action:

```json
{
  "forward": 1,
  "turn": 0.25,
  "attack": false,
  "use": false,
  "tics": 35,
  "captureAfter": true
}
```

The command is injected after LinuxDOOM selects the console player's real net/demo command inside `G_Ticker()`, immediately before gameplay consumes it. It does not fake keyboard DOM events and does not rewrite arbitrary WASM memory.

Movement stays inside the original DOOM command envelope: fast forward maps to 50 ticcmd units, fast strafe to 40 and full turn to the original fast keyboard turn magnitude.

## `doom_run_input_sequence`

Runs up to 16 short actions sequentially, capped at 700 requested world tics total. The sequence stops early if the player dies.

This is intended for short tactical plans, not blind full-level scripting.

Example:

```text
1. move forward for 30 tics
2. turn right for 18 tics
3. move forward + attack for 45 tics
4. use for 2 tics
5. capture the final frame and telemetry
```

## `doom_agent_input_status`

Reports the currently queued autonomous input and its remaining world-tic lifetime.

## `doom_cancel_agent_input`

Clears queued autonomous input immediately.

# Why the input lifetime is deterministic

The AI command lifetime is **not** decremented by browser frames or by prebuilt networking commands.

```text
G_Ticker selects players[consoleplayer].cmd
  ↓
v0.8 bounded ticcmd override
  ↓
P_Ticker world simulation
  ↓
v0.7 telemetry hook
  ↓
v0.8 input lifetime -1 tic
```

When the world is paused, ordinary browser/render frames consume no autonomous-input lifetime. Exact v0.7 step requests are therefore directly composable with v0.8 input.

Holding `attack` behaves like holding DOOM's fire control. Holding `use` follows normal DOOM debounce behavior, so a short 1–2 tic use action is usually appropriate for a door or switch.

# v0.7 playtest / vision tools retained

- `doom_playtest_status`
- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`

`doom_capture_frame` returns the final SDL/Emscripten browser canvas as MCP image content plus matching telemetry.

Telemetry includes world time, visited sectors, approximate movement distance, health/damage/healing, deaths, kills/items/secrets and ammunition.

# Existing authoring tools retained

Inspection:

- `doom_get_state`
- `doom_get_enemies`
- `doom_get_sectors`
- `doom_get_linedefs`
- `doom_get_visuals`
- `doom_list_visual_assets`
- `doom_get_changeset`

Persistent mutation:

- `doom_set_sector_light` → `SECTORS`
- `doom_spawn_enemy` / `doom_remove_nearest_enemy` → `THINGS`
- `doom_set_linedef_action` → `LINEDEFS`
- `doom_set_wall_texture` → `SIDEDEFS`
- `doom_set_sector_flat` → `SECTORS`

Iteration:

- `doom_export_pwad`
- `doom_list_exports`
- `doom_load_pwad`
- `doom_reload_current_map`

# Recommended v0.8 AI loop

```text
1. Inspect current world + frame.
2. Reset playtest metrics.
3. Choose a short action (roughly 5–70 tics).
4. Run it with doom_run_input.
5. Read resulting frame + telemetry.
6. Detect progress, collision/stall, damage or enemy pressure.
7. Choose another short action.
8. If the design itself is the problem, edit actors/light/doors/materials.
9. Reload or continue playtest.
10. Export the accepted result as PWAD.
```

A useful stuck heuristic is: substantial forward input + near-zero `distanceUnits` growth. The AI can then turn, inspect the frame or try `use` instead of continuing to push blindly.

# Architecture

```text
MCP client
   │ stdio
   ▼
playtest_server.js (v0.8)
   ├── v0.6 authoring tools
   ├── v0.7 frame / telemetry / exact-step tools
   └── v0.8 deterministic input / sequence tools
       │
       ├──── :3777/control   authoring
       └──── :3778/playtest  vision + autonomous input
                         │
                         ▼
                 Browser / DoomControl
                         │
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
 authoring modules  doom_playtest.c   doom_agent_input.c
 PWAD/ChangeSet     pause/metrics     bounded ticcmd override
       └─────────────────┬──────────────────┘
                         ▼
                    LinuxDOOM
                 G_Ticker → P_Ticker
```

# Persistence boundary

Autonomous input is **playtest-only**. It never becomes part of the PWAD.

Persistent content remains:

```text
THINGS    actor placement
LINEDEFS  existing special / tag behavior
SIDEDEFS  wall textures
SECTORS   light + floor/ceiling flats
```

`VERTEXES`, `SEGS`, `SSECTORS`, `NODES`, `REJECT` and `BLOCKMAP` remain unchanged.

# Next milestone

v0.8 gives an AI agency, but it still chooses actions turn by turn through the MCP host. The next useful milestone is **v0.9 design-goal evaluation / automated playtest policy**: structured goals such as survivability, visibility, traversal progress and encounter pressure, with repeatable acceptance criteria before a PWAD is accepted.