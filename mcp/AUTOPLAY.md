# Autoplay — autonomous stage clearing

`autoplay_stage_runner.mjs` drives the original LinuxDOOM runtime through a
complete single-player level: plan a route from the Player 1 start to the exit,
follow it with the exact-tic browser controller, press the exit switch and
confirm that the engine left `GS_LEVEL`.

This is **layer 1** of the autoplay stack. It is fully deterministic and needs
no AI service. Layer 2 (a TypeSafe System One tactical policy) plugs into the
`decide` hook described below.

## Run

From `mcp/`:

```bash
npm install
npm run autoplay:e1m1          # 3 god-mode runs, checks tic-for-tic determinism
npm run autoplay:e1m1:live     # 1 run without god mode (monsters can kill you)

node autoplay_stage_runner.mjs --map E1M1 --runs 3 [--no-god] [--max-edge-tics 280] [--report-dir DIR]
```

The runner starts the local game bridge itself (`DOOM_MCP_PORT`, default 3777),
serves the runtime from `direct/` or `mcp/.cache/direct-runtime`, and exits when
the trial is written.

If the host's Chromium does not match the pinned Playwright revision, point the
launcher at an executable:

```bash
DOOM_MCP_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npm run autoplay:e1m1
```

## Pipeline

```text
doom1.wad ── EpisodeWorkspace(E1M1) ── pinned ZDBSP rebuild ── autoplay-e1m1.wad
                     │
          buildNavigationGraph ── findExitProgression(start sector)
                     │                       │
                     │              sector route + exit line (+ keys)
                     ▼                       ▼
  Chromium ── coldBoot(PWAD) ── warp E1M1 ── pause world
                     │
        for each route edge: navigateEdge()  (exact-tic ticcmd steps)
                     │
        approachAndUseExit()  → USE on the exit line
                     │
        getState().ready === false && gameState !== 0   → CLEARED
```

Every step (state before, command, world tic, door opening, health) is
appended to `<reportDir>/steps.jsonl`; `report.json` holds the plan, per-edge
results, the final telemetry sample and a summary with clear rate and a
`deterministic` flag (all cleared runs used the same number of world tics).

## Route following details

`navigateEdge` in `navigation_browser_agent.mjs` gained three options:

| Option | Purpose |
|---|---|
| `acceptSectors` | A set of later route sectors. Thin sectors (door frames, step lips) can be crossed without the player centre ever registering inside them, so landing in any later sector counts as progress and the runner skips ahead. |
| `useNearPortal` / `doorSector` | A closed door directly behind a portal blocks the player radius before the centre can enter the door frame. When the next edge is a door, USE is pressed at this portal. The door sector's live ceiling/floor opening is sampled each step. |
| `decide`, `onStep` | Policy hook and step observer (see below). |

USE is pressed only when the tracked door is closed or closing. Vanilla
`EV_VerticalDoor` toggles a moving door, so pressing USE while it opens would
close it again. This was the cause of the first E1M1 failure at the door
before the exit corridor.

## Policy hook for layer 2

```js
await runStageClearTrial({
  map: 'E1M1',
  godMode: false,
  decide: async ({ state, edge, exit, proposal, usedTics }) => {
    // state: DoomControl.getState() (player, ammo, visible enemies with
    //        distance / relativeAngle / lineOfSight ...)
    // proposal: the deterministic command for this step
    // return a full command { forward, strafe, turn, attack, use, tics, source }
    // or a falsy value to keep the proposal.
    return null;
  }
});
```

The world is paused between steps, so the latency of an external judgment
service never affects gameplay and every run stays replayable from
`steps.jsonl`. Set `source` on a returned command (for example `'jev'`) to have
it recorded in the step log.

## Layer 2: Jev tactical policy

`autoplay_jev_policy.mjs` implements the `decide` hook with TypeSafe System
One judgments. `autoplay_jev_smoke.mjs` makes one real call over a recorded
scene so credentials, network, answer schema and per-call cost are confirmed
before a trial spends anything.

```bash
export TYPESAFE_API_KEY=...            # never commit it; console.typesafe.ai
npm run autoplay:jev:smoke             # one systemOne call, prints answers + usage
npm run autoplay:e1m1:jev:dry          # full trial, records what WOULD be sent, no API calls
npm run autoplay:e1m1:live             # deterministic baseline -> exports/autoplay/e1m1
npm run autoplay:e1m1:jev              # live Jev trial -> exports/autoplay/e1m1-jev, ranked against the baseline
npm run autoplay:dashboard             # exports/autoplay/e1m1-jev/dashboard.html
node autoplay_stage_runner.mjs --map E1M1 --runs 3 --no-god --policy jev --jev-max-calls 600 \
  --report-dir exports/autoplay/e1m1-jev --baseline exports/autoplay/e1m1/report.json
```

## Objective: what a better run means

`autoplay_objective.mjs` holds one definition used by both the report and the
policy prompt, so the metric a trial is judged on and the goal Jev is briefed
with cannot drift apart.

Runs are ranked lexicographically:

| Rank | Metric | Source |
|---|---|---|
| 1 | `deaths` | telemetry; a run that did not clear ranks last |
| 2 | `damageTaken` | telemetry (health points lost) |
| 3 | `totalTics` | world tics to leave `GS_LEVEL` (35 = 1 s) |

Kills, ammo and items are reported but do not rank a run: killing is only
worth the time when it lowers the damage the player would otherwise take.
The same sentence is sent to Jev as `state.objective` and inside the `mode`
question's context (`OBJECTIVE_BRIEF`).

`report.summary.objective` carries the ranking, the best run's metrics and,
with `--baseline other/report.json`, the deltas of this trial's best run
against the baseline's best run plus a one-line verdict
(`better: damageTaken 33 -> 10`, `worse: did not clear`, ...). The CLI prints
both lines after the summary.

## Dashboard

`autoplay_dashboard.mjs <reportDir> [--baseline DIR] [--out FILE]` renders one
self-contained HTML page from `report.json`, `steps.jsonl` and `jev.jsonl`:
objective tiles with baseline deltas, player health of both runs on one time
axis, the Jev mode chosen at every consultation (one lane per mode, filled dot
= override applied, hollow = proposal kept), the danger score, mode counts and
the full decision table. No dependencies, no network, works offline; hover
gives a shared crosshair across the three time charts.

It reads logs only, so it can be regenerated for any past trial and never
touches the game runtime. An in-game overlay (drawing the same data on the
`#hud` layer while the world is paused) is the natural next step for videos.

Design, following the typesafe-ai skill guidance (code owns the workflow,
the model supplies narrow typed judgments):

| Piece | What it does |
|---|---|
| `shouldConsult` | Gate: only steps with a visible enemy or health below 40 ask the model. Everything else keeps the deterministic proposal for free. |
| `compactState` | Named-field state: player health/armor/weapon/ammo, route phase and waypoint bearing, up to 5 nearest visible enemies with distance and bearing (positive = left). |
| `buildQuestions` | Four parallel questions over that state: `mode` choice (advance / fight / retreat / dodge), `target` choice (one label per visible enemy + none), `fire` noul, `danger` score (safe / caution / critical). |
| `answersToCommand` | Maps the answers to the same bounded ticcmd vocabulary as the follower: fight turns toward the target then holds ATTACK when aligned within 8 degrees; retreat backs off facing the target; dodge strafes; advance keeps the proposal (and fires if aligned). |
| `maxCalls` | Hard cost cap per trial; after it the policy silently stops consulting and the report shows `capped: true`. |
| safety rules | Code-owned overrides applied on top of the answers (below). |

### Safety rules (policy 0.3.0)

Code owns the safety rules; the model only supplies judgments. Three rules
were added after the first live trial (see "First live result" below):

| Rule | Trigger | Effect | Knobs |
|---|---|---|---|
| `stall` | no net progress of `stallDistance` map units across the last `stallWindow` consultations while the nearest visible enemy is within `meleeRange` | mode forced to `fight` at the nearest enemy, fire on; logged as `forced: "fight"` and `command.rules: ["stall"]` | `stallWindow` 6, `stallDistance` 32, `meleeRange` 96 |
| `dodgeHold` | consecutive `dodge` answers | the strafe side is held for `dodgeHoldCalls` answers before flipping, so a dodge moves the player instead of cancelling itself | `dodgeHoldCalls` 4 |
| `pointBlank` | a target within `pointBlankDistance` | fired at when aligned whatever the `fire` noul says; when advancing and not aligned, the step turns toward it. The noul threshold is 0.4 (it hovered at 0.45 for an Imp in the player's face) | `pointBlankDistance` 96, `fireThreshold` 0.4 |

`policy.rules` in the report counts how often each rule fired.

Every consultation is written to `<reportDir>/jev.jsonl` (state sent, answers,
probabilities, usage, latency, resulting command) and the run report carries
`policy` stats: calls, overrides, input tokens, estimated input cost at the
published $0.042 per million input tokens (input side only; output tokens are
counted but not priced here).

Dry-run reference on the live E1M1 baseline run:

```text
eligible steps      165 of 420 (enemies visible)
approx input tokens 76,933 (~430 per call, chars/4 estimate)
estimated cost      ~$0.003 per E1M1 clear
```

Real token counts come from `usage.input_tokens` once the API is reachable;
the dry-run figure is an approximation.

### First live result (policy 0.2.0, jev-1.13.0)

```text
baseline (no policy)   CLEARED, 1167 tics, damage 33, min health 67, kills 0
jev policy             FAILED player_dead, 1140 tics alive, damage 100, kills 1
                       239 calls (165 eligible steps in the baseline; the stall
                       added consultations), 51 overrides, 239k input tokens,
                       ~$0.010, 160 ms avg latency
modes chosen           advance 191, dodge 48, fight 0, retreat 0
fire noul              never above 0.49 (threshold 0.5), so no shot was fired
```

Where it went wrong: edge `72:74:309`, the corridor before the exit door. The
baseline follower crosses sector 72 in 33 tics. With Jev, an Imp closed to
melee range (42-50 units, bearing within 15 degrees) and every consultation
returned `dodge` (strafe, alternating side each call) or `advance` with
`fire` just under threshold. The alternating strafe cancelled out, the player
stayed pinned in sector 72 for 273 tics and was clawed to death without ever
shooting. The dashboard makes this visible as a flat health staircase against
a dense `dodge` lane and a rising danger score.

What this says about the policy, not the model: the code owns the safety
rules, and two are missing. (1) A stall rule: no progress along the edge for
N steps with an enemy inside melee range must force `fight` regardless of the
answers. (2) Dodge must hold one side for several calls instead of flipping
every call. The fire threshold (0.5 on a `noul` that hovers at 0.45 for an Imp
in the player's face) is the third candidate. These are the next tuning
targets; the objective and dashboard above exist to measure them.

## Determinism

The world only advances through exact-tic steps, so a trial is a pure function
of the engine state at its first step. Two things had to be pinned for that:

1. `coldBoot(..., { pauseOnReady: true })` freezes the world inside the
   readiness poll instead of after it, cutting the boot race to 0-2 tics.
2. The runner then issues idle exact-tic steps until `levelTime` equals
   `START_LEVEL_TIC` (3), so every trial's control loop starts on the same
   world tic. `report.summary.levelTimeAtPause` shows the raw race per run and
   `startLevelTic` the normalised value.

Without step 2, runs that froze on tic 0 and tic 1 diverged by ~20 tics.

## Reference results

Shareware E1M1, this environment (Chromium headless, Playwright 1.55):

```text
route          20 transitions (5 doors, 1 lift), 0 keys
exit           line 330, special 11 (switch)

god mode x3    CLEARED 3/3, 1296 world tics each (~37 s game time), 488 steps
               levelTimeAtPause 2/1/0 -> startLevelTic 3/3/3, deterministic: true
live monsters  CLEARED 1/1, 1167 world tics, 0 deaths, min health 67
```

The live run cleared without any combat policy: the route follower simply
outran the E1M1 opposition while taking 33 damage. That is the baseline a
layer-2 policy has to beat (fewer damage, fewer tics, higher clear rate on
harder maps), and `steps.jsonl` from the live run marks where enemies were
visible so the policy's decision points can be chosen from data.
