# Web DOOM — Direct LinuxDOOM + AI Level Authoring MCP v1

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended with a local MCP system for bounded AI level authoring, autonomous deterministic playtesting, visual observation, explicit design-goal evaluation, candidate checkpointing and final PWAD delivery.

The `/direct/` runtime starts from the original LinuxDOOM source. It does **not** use doomgeneric or Chocolate Doom as the game runtime.

## Play

- [Direct LinuxDOOM WebAssembly build](https://pavy23.github.io/web-doom/direct/)
- [Earlier doomgeneric comparison build](https://pavy23.github.io/web-doom/)

Development branch: [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom)

Current MCP version: **1.0.0**

## What this project became

The project started as a browser-port experiment. v1.0 is now a small **AI-native game-content authoring, playtest and evaluation pipeline**.

```text
AI design goal
      ↓
semantic inspection
      ↓
bounded authoring plan
actors / light / doors / materials
      ↓
candidate PWAD checkpoint
      ↓
reload candidate as fresh baseline
      ↓
autonomous ticcmd playtest
      ↓
exact P_Ticker world tics
      ↓
telemetry + PNG frame
      ↓
deterministic evaluator
+ optional AI vision rubric
      ↓
PASS / FAIL + revision hints
      ↓
next bounded revision
or restore previous candidate
      ↓
passing candidate
      ↓
final ordinary PWAD
```

The roles are intentionally separate:

- **MCP-host AI** — interprets the design goal and chooses bounded edits
- **MCP v1 orchestrator** — enforces iteration limits, checkpoints candidates, runs trials and finalizes artifacts
- **LinuxDOOM** — real gameplay simulation and validator
- **Evaluator** — explicit repeatable acceptance criteria
- **PWAD** — persistent playable artifact

The server does not embed a hidden second LLM. The connected AI remains responsible for design reasoning; the orchestration layer provides a deterministic, bounded execution loop.

# v1.0 — Closed-loop authoring sessions

The main v1 tools are:

- `doom_orchestrator_status`
- `doom_begin_design_session`
- `doom_run_authoring_iteration`
- `doom_review_design_iteration`
- `doom_get_design_session`
- `doom_restore_design_candidate`
- `doom_finalize_design_session`

A session starts by freezing the current map as a baseline PWAD. Every authoring iteration then:

```text
<= 12 semantic edits
      ↓
session-0001-iter-01.wad
      ↓
validate + reload
      ↓
ChangeSet reset
      ↓
restart from candidate baseline
      ↓
<= 16 autonomous actions
<= 700 actual world tics
      ↓
telemetry evaluation
      ↓
final PNG
```

If a visual rubric is part of the goal, the MCP-host AI inspects that frame and attaches `0..1` scores with reasons using `doom_review_design_iteration`.

The session is capped at **8 iterations**. A worse iteration can be abandoned by restoring the baseline or any previous candidate PWAD. Finalization normally accepts only a passing candidate; selecting a failing candidate requires an explicit `force=true`.

Candidate checkpoints and the final artifact are real `.wad` files stored under the MCP export directory.

Example artifact chain:

```text
session-0001-baseline.wad
session-0001-iter-01.wad   score 64
session-0001-iter-02.wad   score 78
session-0001-iter-03.wad   score 86 ✓
horror_e1m1_final.wad
```

# Design-goal evaluation

The deterministic evaluator does not call an LLM.

```text
engine telemetry
      +
optional AI vision scores
      ↓
fixed goal + weights
      ↓
0..100 score
pass/fail
failure reasons
revision hints
```

Example goal:

```json
{
  "name": "opening_horror_encounter",
  "hard": {
    "maxDeaths": 0,
    "minFinalHealth": 20
  },
  "targets": {
    "maxDamageTaken": 45,
    "minVisitedSectors": 3,
    "minDistanceUnits": 180,
    "maxStuckActions": 1,
    "minKills": 2,
    "minScore": 0.75
  },
  "visualRubric": [
    { "id": "atmosphere", "minScore": 0.75 },
    { "id": "enemy_readability", "minScore": 0.65 },
    { "id": "navigation_clarity", "minScore": 0.65 }
  ]
}
```

The evaluator measures deaths, final/minimum health, damage, traversal distance, sectors visited, stuck actions, kills and pacing. Visual criteria remain explicit and are not silently assumed to pass when a goal requires them.

Retained evaluation tools:

- `doom_run_design_trial`
- `doom_evaluate_playtest`
- `doom_get_trial_history`
- `doom_compare_trials`

# Current authoring surface

## Semantic inspection

- `doom_get_state`
- `doom_get_enemies`
- `doom_get_sectors`
- `doom_get_linedefs`
- `doom_get_visuals`
- `doom_list_visual_assets`
- `doom_get_changeset`

## Persistent authoring

- actor spawn/remove → `THINGS`
- door/trigger special + tag → `LINEDEFS`
- wall textures → `SIDEDEFS`
- sector lighting → `SECTORS`
- floor/ceiling flats → `SECTORS`

Key tools:

- `doom_spawn_enemy`
- `doom_remove_nearest_enemy`
- `doom_set_sector_light`
- `doom_set_linedef_action`
- `doom_set_wall_texture`
- `doom_set_sector_flat`

## PWAD iteration

- `doom_export_pwad`
- `doom_list_exports`
- `doom_load_pwad`
- `doom_reload_current_map`

# Playtest observation and agency

Observation:

- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`

Autonomous input:

- `doom_agent_input_status`
- `doom_cancel_agent_input`
- `doom_run_input`
- `doom_run_input_sequence`

AI movement is not browser keyboard simulation. A bounded override is applied to the console player's real `ticcmd_t` after LinuxDOOM selects the command in `G_Ticker()` and before normal gameplay consumes it in `P_Ticker()`.

```text
forward  -1.0 .. +1.0
strafe   -1.0 .. +1.0
turn     -1.0 .. +1.0
attack   false / true
use      false / true
tics     1 .. 350
```

Input lifetime decreases only after actual world simulation tics, not browser render frames.

# Architecture

```text
id Software LinuxDOOM 1.10
          │
          ├── original gameplay / renderer / WAD / state
          ├── browser i_video / i_system / i_sound / i_net
          ├── doom_control.c        state / actor / sector / PWAD
          ├── doom_linedefs.c       door + trigger authoring
          ├── doom_visuals.c        wall + flat authoring
          ├── doom_playtest.c       pause / exact tic / telemetry
          ├── doom_agent_input.c    bounded ticcmd player agency
          └── doom_reload.c         PWAD validation / runtime reload
                    │
                    ↓
             Emscripten / WASM
                    │
                    ↓
                  Browser
          ┌─────────┼─────────┐
          │         │         │
  :3777/control :3778/playtest :3779/orchestrate
          │         │         │
          └─────────┼─────────┘
                    ↓
             mcp/v1_server.js
          ┌─────────┴──────────┐
          │                    │
 mcp/evaluator.js      mcp/orchestrator.js
          │                    │
          └─────────┬──────────┘
                    ↓
               stdio MCP host
```

`orchestration_bridge.js` reuses the same explicit `DoomControl` functions as the earlier bridges. It does not expose arbitrary WASM memory.

The public GitHub Pages game does not connect to localhost during normal play. Local MCP bridges activate only when the page is loaded through the local MCP proxy.

# Quick start

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

Click **CLICK TO START**.

Generic MCP client configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/v1_server.js"]
}
```

Detailed guide: [`mcp/README.md`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/README.md)

# Persistence boundary

The current project deliberately edits existing geometry semantics rather than pretending arbitrary geometry changes are safe.

Persistent map patches:

```text
THINGS
LINEDEFS
SIDEDEFS
SECTORS
```

Currently unchanged topology/BSP data:

```text
VERTEXES
SEGS
SSECTORS
NODES
REJECT
BLOCKMAP
```

Arbitrary new-room geometry remains outside this first v1 milestone until a real node/blockmap rebuild pipeline is introduced.

# Audio

Sound effects use direct DMX type-3 decoding through SDL2_mixer.

Music uses a Vanilla/DMX-compatible OPL register path with IWAD `GENMIDI` instrumentation and Nuked OPL3 v1.8 running in OPL2-compatible mode. The required OPL/MIDI subsystem is imported from pinned Chocolate Doom revision `410d96855b5df5410ff591a90efeafa889119224`; Chocolate Doom is not the game runtime.

LinuxDOOM baseline:

`a77dfb96cb91780ca334d0d4cfd86957558007e0`

Public shareware IWAD:

- size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

# v1 completion boundary

This first DOOM MCP track is considered functionally complete when the following local round trip succeeds in a real MCP-host session:

```text
design goal
→ bounded edit plan
→ candidate PWAD checkpoint/reload
→ autonomous deterministic playtest
→ telemetry + frame evaluation
→ bounded revision / restore
→ passing candidate
→ final PWAD
```

The next research direction is less about adding more DOOM-specific controls and more about generalizing this pattern to richer content engines and production pipelines.
