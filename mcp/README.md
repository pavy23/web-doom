# Web DOOM MCP — v1 Closed-loop AI Level Authoring

This directory contains the local MCP control plane for the direct LinuxDOOM WebAssembly port.

Current MCP version: **1.0.0**.

v1.0 closes the first full authoring loop:

```text
AI design goal
  ↓
bounded semantic edits
  ↓
candidate PWAD checkpoint
  ↓
reload candidate as fresh baseline
  ↓
autonomous deterministic playtest
  ↓
telemetry score + final PNG
  ↓
AI vision rubric
  ↓
pass / fail + revision hints
  ↓
next bounded iteration or restore older candidate
  ↓
passing candidate
  ↓
final playable PWAD
```

The MCP server does **not** embed another hidden LLM. The connected MCP-host AI remains responsible for interpreting the design goal and choosing each bounded edit plan. The v1 orchestrator enforces limits, checkpoints every iteration, runs deterministic trials, evaluates results and only finalizes an explicitly selected or passing candidate.

## Setup

Requirements: Node.js 20+, npm and an MCP client.

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout direct-linuxdoom
cd mcp
npm install
npm start
```

`npm start` now launches `v1_server.js`.

Open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**.

Local bridges:

```text
127.0.0.1:3777/control       bounded authoring
127.0.0.1:3778/playtest      vision / telemetry / exact-tic / agent input
127.0.0.1:3779/orchestrate   v1 compositional session loop
```

Generic MCP host configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/v1_server.js"]
}
```

Do not run `npm start` separately if the MCP host is already launching the same `v1_server.js`, unless you deliberately use different local ports.

# v1.0 session tools

## `doom_begin_design_session`

Starts a bounded design session and immediately checkpoints the current map as a baseline PWAD.

Inputs include:

```text
goal                 structured v0.9 design goal
maxIterations        1..8, default 5
finalFilename        requested final PWAD name
adoptPendingChanges  false by default
```

If persistent authoring edits are already pending, the tool refuses to silently absorb them unless `adoptPendingChanges=true` is explicit.

Example goal:

```json
{
  "name": "opening_horror_encounter",
  "description": "Tense, readable and survivable opening.",
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
  "weights": {
    "survivability": 0.35,
    "traversal": 0.25,
    "combat": 0.15,
    "pacing": 0.10,
    "visual": 0.15
  },
  "visualRubric": [
    { "id": "atmosphere", "minScore": 0.75 },
    { "id": "enemy_readability", "minScore": 0.65 },
    { "id": "navigation_clarity", "minScore": 0.65 }
  ]
}
```

A baseline artifact such as this is written into `mcp/exports/`:

```text
session-0001-baseline.wad
```

## `doom_run_authoring_iteration`

Runs one complete candidate iteration.

One call performs:

```text
apply <= 12 bounded authoring edits
  ↓
export session-0001-iter-01.wad
  ↓
validate + reload that PWAD
  ↓
ChangeSet becomes zero
  ↓
restart map from candidate baseline
  ↓
run <= 16 deterministic input actions
  ↓
<= 700 actual P_Ticker world tics
  ↓
evaluate telemetry
  ↓
return score + failure reasons + revision hints + final PNG
```

Allowed persistent edit types are deliberately bounded:

```text
sector_light
a spawn_enemy
remove_nearest_enemy
linedef_action
wall_texture
sector_flat
```

`spawn_enemy` is restricted to the existing Episode-1-safe allow-list. `linedef_action` uses the existing Vanilla-compatible door preset allow-list. Wall and flat names are still validated by the engine against loaded IWAD assets.

Example conceptual iteration:

```json
{
  "sessionId": "session-0001",
  "rationale": "Opening is too bright and combat pressure is weak.",
  "edits": [
    { "type": "sector_light", "sector": 3, "light": 48 },
    { "type": "spawn_enemy", "enemy": "imp", "count": 2, "distance": 192 }
  ],
  "actions": [
    { "forward": 1, "tics": 30 },
    { "turn": 0.4, "tics": 15 },
    { "forward": 1, "attack": true, "tics": 45 },
    { "use": true, "tics": 2 }
  ]
}
```

The returned PNG is the actual SDL/Emscripten canvas after the candidate trial.

## `doom_review_design_iteration`

Attach AI-vision scores to the frame returned by an iteration.

Example:

```json
{
  "sessionId": "session-0001",
  "iteration": 1,
  "visualAssessment": {
    "atmosphere": {
      "score": 0.88,
      "reason": "Strong dark hierarchy and distant silhouette tension."
    },
    "enemy_readability": {
      "score": 0.58,
      "reason": "The closest imp blends into the wall material."
    },
    "navigation_clarity": {
      "score": 0.74,
      "reason": "The intended exit remains distinguishable."
    }
  }
}
```

The same deterministic evaluator then recomputes pass/fail using both engine telemetry and the visual rubric.

## `doom_get_design_session`

Returns the session goal and every candidate iteration, including:

```text
candidate filename
edit plan
applied edit results
persistent ChangeSet counts
trial id
score
pass/fail
hard/target/visual failures
revision hints
```

Session state is currently process-memory only. Candidate and final PWAD files are persistent on disk.

## `doom_restore_design_candidate`

Reload iteration `0` for the original session baseline, or any previously checkpointed iteration.

This supports safe branching:

```text
iteration 1  score 72
iteration 2  score 58  ← bad revision
        ↓
restore iteration 1
        ↓
try a different iteration 3 plan
```

Pending unexported edits are protected unless `discardChanges=true` is explicit.

## `doom_finalize_design_session`

Selects either:

- an explicit iteration, or
- the highest-scoring passing iteration.

The chosen checkpoint is restored and copied to the requested final PWAD filename.

A failing candidate is rejected unless `force=true` is explicit.

Example output artifact:

```text
mcp/exports/horror_e1m1_final.wad
```

That file is an ordinary playable PWAD, not an MCP-specific runtime format.

# Recommended v1 AI policy

Use this pattern rather than issuing one huge blind prompt:

```text
1. Inspect map state, sectors, enemies, linedefs and valid materials.
2. Define a measurable design goal.
3. doom_begin_design_session.
4. Propose a small bounded edit plan that targets one or two failure dimensions.
5. doom_run_authoring_iteration.
6. Inspect returned PNG and telemetry.
7. doom_review_design_iteration when visualRubric is present.
8. If failed, use revisionHints and make another small iteration.
9. If an iteration becomes worse, restore a better checkpoint.
10. Stop on acceptance or the session iteration cap.
11. doom_finalize_design_session.
```

The current hard limits are:

```text
maximum design iterations       8
maximum persistent edits/iter  12
maximum trial actions          16
maximum trial world tics      700
maximum one action            350 tics
```

These limits exist to keep the MCP-host AI in a short inspect/act/evaluate loop rather than letting it perform uncontrolled long-running edits or playtests.

# Revision hints

`mcp/orchestrator.js` maps failed evaluation dimensions back to the bounded edit surface.

Examples:

```text
survivability failure
→ remove enemy pressure / improve lighting or contrast

traversal or stuck failure
→ inspect door linedef / lighting / wall or flat navigation cues

combat goal failure
→ revise encounter density while preserving survivability

visual rubric failure
→ sector light / wall texture / floor-ceiling flat
```

The hints do not edit the level themselves. The MCP-host AI decides the actual bounded edit call.

# v0.9 evaluation retained

The deterministic evaluator in `evaluator.js` still scores:

- deaths
- final/minimum health
- damage taken
- visited sectors
- distance travelled
- stuck movement actions
- kills
- elapsed time
- optional AI-vision rubric criteria

The evaluator does not call an LLM and does not mutate the level.

Retained v0.9 tools:

- `doom_run_design_trial`
- `doom_evaluate_playtest`
- `doom_get_trial_history`
- `doom_compare_trials`

# v0.8 autonomous input retained

- `doom_run_input`
- `doom_run_input_sequence`
- `doom_agent_input_status`
- `doom_cancel_agent_input`

Input is applied through LinuxDOOM's real console-player `ticcmd_t` path and is consumed only by actual `P_Ticker()` world updates.

# v0.7 observation retained

- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`

# Authoring surface retained

Inspection:

- `doom_get_state`
- `doom_get_enemies`
- `doom_get_sectors`
- `doom_get_linedefs`
- `doom_get_visuals`
- `doom_list_visual_assets`
- `doom_get_changeset`

Persistent authoring:

- `doom_set_sector_light` → `SECTORS`
- `doom_spawn_enemy` / `doom_remove_nearest_enemy` → `THINGS`
- `doom_set_linedef_action` → `LINEDEFS`
- `doom_set_wall_texture` → `SIDEDEFS`
- `doom_set_sector_flat` → `SECTORS`

PWAD iteration:

- `doom_export_pwad`
- `doom_list_exports`
- `doom_load_pwad`
- `doom_reload_current_map`

# Persistence boundary

v1.0 intentionally still edits **existing geometry semantics**, not arbitrary map topology.

Persistent records:

```text
THINGS
LINEDEFS
SIDEDEFS
SECTORS
```

Unchanged topology/BSP-derived records:

```text
VERTEXES
SEGS
SSECTORS
NODES
REJECT
BLOCKMAP
```

Arbitrary new-room geometry and node rebuilding remain outside this first v1 milestone.

# Architecture

```text
MCP-host AI
   │ stdio
   ▼
v1_server.js
   ├── all v0.1~0.9 tools
   ├── bounded session state machine
   ├── iteration checkpoint / restore / finalize
   └── deterministic trial + evaluation composition
        │
        ├── :3777/control
        ├── :3778/playtest
        └── :3779/orchestrate
                    │
                    ▼
                Browser
                    │
              DoomControl API
                    │
                    ▼
                LinuxDOOM
          G_Ticker → P_Ticker
                    │
                    ▼
             ordinary PWAD files
```

`orchestration_bridge.js` reuses the same explicit `DoomControl` methods that earlier versions expose. It does not provide arbitrary WASM-memory access.

# v1 completion boundary

The first DOOM MCP project is considered functionally complete at v1.0 when this local round trip works in a real MCP-host session:

```text
design goal
→ bounded edits
→ candidate PWAD
→ reload
→ autonomous trial
→ image + telemetry evaluation
→ revision
→ passing candidate
→ final PWAD
```

The next research direction should focus less on adding more DOOM-specific knobs and more on generalizing this authoring/evaluation pattern to richer engines and content pipelines.
