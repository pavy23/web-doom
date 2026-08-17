# Web DOOM — Direct LinuxDOOM + AI Authoring / Playtest MCP

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended with a local MCP control plane for bounded AI level authoring, autonomous playtesting, visual observation, repeatable design-goal evaluation, PWAD export and iterative reload.

The `/direct/` runtime starts from the original LinuxDOOM source. It does **not** use doomgeneric or Chocolate Doom as the game runtime.

## Play

- [Direct LinuxDOOM WebAssembly build](https://pavy23.github.io/web-doom/direct/)
- [Earlier doomgeneric comparison build](https://pavy23.github.io/web-doom/)

Development branch: [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom)

Current MCP version: **0.9.0**

## What this project became

The project started as a browser-port experiment. It is now a small **AI-native game-content authoring and evaluation sandbox**.

```text
AI design goal
      ↓
semantic inspection
      ↓
level authoring
actors / light / doors / materials
      ↓
LinuxDOOM live runtime
      ↓
autonomous ticcmd playtest
      ↓
exact world tics
      ↓
telemetry + PNG frame
      ↓
deterministic evaluator
+ optional AI vision rubric
      ↓
revise or accept
      ↓
ChangeSet → PWAD
      ↓
reload as next baseline
```

The roles are intentionally separate:

- **MCP** — AI-facing semantic authoring, execution and observation interface
- **LinuxDOOM** — real gameplay simulation and validator
- **Evaluator** — explicit repeatable acceptance criteria
- **PWAD** — persistent playable artifact

# Current capabilities

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

An exported candidate can be loaded back through LinuxDOOM's WAD system and becomes the next editing baseline.

## Playtest observation

- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`

The frame tool returns the final SDL/Emscripten canvas as MCP image content plus matching telemetry.

Telemetry includes actual world tics, time, visited sectors, approximate movement distance, health, damage/healing, deaths, kills/items/secrets and ammunition.

## Autonomous player agency

- `doom_agent_input_status`
- `doom_cancel_agent_input`
- `doom_run_input`
- `doom_run_input_sequence`

AI movement is not implemented with browser keyboard simulation. A bounded override is applied to the console player's real `ticcmd_t` after LinuxDOOM selects the command in `G_Ticker()` and before normal gameplay consumes it in `P_Ticker()`.

Supported bounded controls:

```text
forward  -1.0 .. +1.0
strafe   -1.0 .. +1.0
turn     -1.0 .. +1.0
attack   false / true
use      false / true
tics     1 .. 350
```

A sequence is limited to 16 actions and 700 requested world tics. Input lifetime decreases only after actual world simulation tics, not browser render frames.

# v0.9 — Design-goal evaluation

v0.9 adds the missing question:

> The AI can edit and play the level — but how does it decide whether the result is actually better?

The evaluator is deliberately deterministic and does not call an LLM.

```text
engine telemetry
      +
optional AI vision scores
      ↓
explicit goal + weights
      ↓
0..100 score
pass/fail
failure reasons
revision hints
```

New tools:

- `doom_run_design_trial`
- `doom_evaluate_playtest`
- `doom_get_trial_history`
- `doom_compare_trials`

A design goal can contain hard constraints and softer weighted targets.

Example:

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

`doom_run_design_trial` resets telemetry, executes a bounded action plan, stores each action's before/after metrics, evaluates the result and returns the final PNG.

The MCP-host AI can inspect that PNG and attach visual scores with reasons:

```json
{
  "trialId": "trial-0001",
  "visualAssessment": {
    "atmosphere": { "score": 0.88, "reason": "Strong dark-room hierarchy." },
    "enemy_readability": { "score": 0.58, "reason": "Imp silhouette blends into the wall." },
    "navigation_clarity": { "score": 0.72, "reason": "Exit remains distinct." }
  }
}
```

The same trial is then re-evaluated with quantitative engine evidence and qualitative vision evidence in one report.

Recent trials are retained in process memory and can be compared:

```text
candidate v1 → 61.4
candidate v2 → 78.7
candidate v3 → 84.2 ✓
```

The trial history is advisory runtime state; **PWAD remains the persistent artifact**.

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
             ┌──────┴──────┐
             │             │
       :3777/control   :3778/playtest
             │             │
             └──────┬──────┘
                    ↓
          mcp/playtest_server.js
                    │
          mcp/evaluator.js
                    │
              stdio MCP host
```

The public GitHub Pages game does not connect to localhost during normal play. Local MCP bridges are used only when the page is loaded through the local MCP proxy.

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
  "args": ["C:/absolute/path/to/web-doom/mcp/playtest_server.js"]
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

Arbitrary new-room geometry remains deferred until a real node/blockmap rebuild pipeline is introduced.

# Audio

Sound effects use direct DMX type-3 decoding through SDL2_mixer.

Music uses a Vanilla/DMX-compatible OPL register path with IWAD `GENMIDI` instrumentation and Nuked OPL3 v1.8 running in OPL2-compatible mode. The required OPL/MIDI subsystem is imported from pinned Chocolate Doom revision `410d96855b5df5410ff591a90efeafa889119224`; Chocolate Doom is not the game runtime.

LinuxDOOM baseline:

`a77dfb96cb91780ca334d0d4cfd86957558007e0`

Public shareware IWAD:

- size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

# Next milestone — v1.0

v0.9 can measure a candidate, explain why it failed and compare iterations.

The v1.0 milestone is the **closed orchestration policy**:

```text
fixed design goal
  ↓
AI bounded edit plan
  ↓
PWAD candidate
  ↓
autonomous trial
  ↓
evaluation
  ↓
failed dimensions only
  ↓
next bounded revision
  ↓
stop when accepted / budget exhausted
  ↓
final PWAD
```

That is the point where this becomes a complete small-scale prototype of an AI content-authoring pipeline rather than a collection of individual MCP controls.
