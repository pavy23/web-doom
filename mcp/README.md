# Web DOOM MCP — AI Authoring, Autonomous Playtest & Evaluation

This directory contains the local MCP layer for the direct LinuxDOOM WebAssembly port.

Current MCP version: **0.9.0**.

The project has progressed through four layers:

```text
v0.6  bounded level authoring
v0.7  frame capture + telemetry + exact world-tic control
v0.8  bounded autonomous player input through real ticcmd_t
v0.9  design goals + repeatable trial scoring + iteration comparison
```

The current loop is:

```text
AI design goal
  ↓
inspect / author map
  ↓
run deterministic design trial
  ↓
telemetry score + final PNG
  ↓
AI vision rubric
  ↓
combined evaluation
  ↓
revise or accept
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

MCP host configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/playtest_server.js"]
}
```

# v0.9 design-goal evaluation

## `doom_run_design_trial`

Runs a repeatable bounded playtest against a structured design goal.

The tool:

1. pauses the world,
2. cancels old autonomous input,
3. resets the telemetry window,
4. executes up to 16 deterministic actions,
5. caps the trial at 700 requested world tics,
6. stores every action's before/after telemetry,
7. scores the result,
8. stores the trial in memory,
9. returns the final PNG frame for vision review.

Example goal:

```json
{
  "name": "opening_horror_encounter",
  "description": "Tense but survivable opening with clear navigation.",
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
    {
      "id": "atmosphere",
      "label": "Horror atmosphere",
      "minScore": 0.75,
      "weight": 1
    },
    {
      "id": "enemy_readability",
      "label": "Enemies are readable but threatening",
      "minScore": 0.65,
      "weight": 1
    },
    {
      "id": "navigation_clarity",
      "label": "Player can infer the route",
      "minScore": 0.65,
      "weight": 1
    }
  ]
}
```

Example action plan:

```json
[
  { "forward": 1, "tics": 30 },
  { "turn": 0.45, "tics": 16 },
  { "forward": 1, "attack": true, "tics": 45 },
  { "use": true, "tics": 2 }
]
```

The first result is a telemetry-based score plus a final frame. If the goal contains a visual rubric, inspect that image and then attach the visual scores using `doom_evaluate_playtest`.

## `doom_evaluate_playtest`

Evaluates either the current telemetry window or a stored trial.

Telemetry dimensions include:

- deaths
- final/minimum health
- damage taken
- visited sectors
- distance travelled
- stuck movement actions
- kills
- elapsed time

Optional vision scores use a `0..1` range and can include a short reason:

```json
{
  "trialId": "trial-0001",
  "visualAssessment": {
    "atmosphere": {
      "score": 0.88,
      "reason": "Dark room hierarchy and distant silhouettes create tension."
    },
    "enemy_readability": {
      "score": 0.58,
      "reason": "The nearest imp blends into the wall texture."
    },
    "navigation_clarity": {
      "score": 0.72,
      "reason": "The exit door remains visually distinct."
    }
  }
}
```

The evaluator returns:

```text
passed
score (0..100)
hardPassed
visualPassed
dimension scores
hardFailures
targetFailures
stuckActions
suggestions
trial summary
```

Hard constraints always matter even if the weighted score is high.

## `doom_get_trial_history`

Returns up to the most recent 20 in-process trials without image payloads.

Each record includes goal, score, pass/fail, failures and summary telemetry.

## `doom_compare_trials`

Compares two to six stored trials and ranks them using the same evaluator output.

This makes it possible to compare authored variants such as:

```text
horror_v1.wad → trial-0001 → 61.4
horror_v2.wad → trial-0002 → 78.7
horror_v3.wad → trial-0003 → 84.2 ✓
```

Trial history is currently **process-memory only**. PWAD files remain the persistent artifact.

# Scoring philosophy

`mcp/evaluator.js` is deliberately deterministic and does not call an LLM.

```text
engine telemetry
      +
optional AI vision rubric
      ↓
explicit scoring function
      ↓
pass/fail + reasons + suggestions
```

This separation matters: the AI can propose or revise content, but it cannot silently redefine success after seeing the result.

The default weighted dimensions are:

```text
survivability  35%
traversal      30%
combat         15%
pacing         10%
visual         10%
```

A goal may override those weights.

# v0.8 autonomous input retained

## `doom_run_input`

Runs one deterministic action through LinuxDOOM's real `ticcmd_t` path for exactly N world tics.

Inputs:

```text
forward  -1.0 .. +1.0
strafe   -1.0 .. +1.0
turn     -1.0 .. +1.0
attack   false / true
use      false / true
tics     1 .. 350
```

## `doom_run_input_sequence`

Runs up to 16 short actions with a total cap of 700 requested world tics.

## `doom_agent_input_status`

Reads the active autonomous command and remaining world-tic lifetime.

## `doom_cancel_agent_input`

Clears autonomous input immediately.

Autonomous input is playtest-only and never enters an exported PWAD.

# v0.7 observation tools retained

- `doom_playtest_status`
- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`

`doom_capture_frame` returns the final SDL/Emscripten canvas as MCP image content plus matching telemetry.

# Authoring tools retained

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

# Persistence boundary

The playable artifact remains a normal PWAD. Persistent content is still limited to existing-geometry records:

```text
THINGS    actor placement
LINEDEFS  existing special / tag behavior
SIDEDEFS  wall textures
SECTORS   light + floor/ceiling flats
```

`VERTEXES`, `SEGS`, `SSECTORS`, `NODES`, `REJECT` and `BLOCKMAP` remain unchanged.

# Recommended v0.9 workflow

```text
1. Define a design goal before editing.
2. Inspect the level and make bounded authoring changes.
3. Reload the candidate PWAD as the baseline if needed.
4. Run doom_run_design_trial with a short action plan.
5. Read the telemetry score and failure reasons.
6. Inspect the returned PNG.
7. Add visual rubric scores with doom_evaluate_playtest.
8. Revise only the failing design dimensions.
9. Run another trial with the same goal.
10. Compare trials.
11. Export/accept the strongest version.
```

# Architecture

```text
MCP client
   │ stdio
   ▼
playtest_server.js (v0.9)
   ├── authoring tools
   ├── vision / telemetry / exact step
   ├── bounded ticcmd player agency
   └── trial runner / history / comparison
             │
             ├──────────── evaluator.js
             │              hard constraints
             │              weighted metrics
             │              optional vision rubric
             │
             ├── :3777/control
             └── :3778/playtest
                         │
                         ▼
                    LinuxDOOM
                 G_Ticker → P_Ticker
```

# Next milestone

v0.9 can now say **why a candidate failed** and compare iterations. The remaining step for v1.0 is the orchestration policy: let the MCP-host AI consume those failures, choose bounded authoring changes, rerun the same goal, stop when the acceptance criteria are met, then export the accepted PWAD.
