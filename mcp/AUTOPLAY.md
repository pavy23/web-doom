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

Budgets: `--max-edge-tics` (280) bounds the route-following steps of one
edge; `--max-combat-tics` (600) separately bounds the fight/retreat steps a
policy spends there (a policy command with `forward <= 0`). Each edge result
reports `routeTics` and `combatTics`; `totalTics` in the objective counts
both, so a long fight still ranks below a quick pass.

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
touches the game runtime.

## Watching a run live: `--headed` and the in-game overlay

```bash
npm run autoplay:e1m1:jev:watch     # opens a Chromium window, overlay on
node autoplay_stage_runner.mjs --map E1M1 --runs 1 --no-god --policy jev --headed
node autoplay_stage_runner.mjs ... --no-overlay      # overlay off
```

`--headed` (or `DOOM_MCP_HEADED=1`) launches a visible Chromium window; the
trial itself is unchanged, since the world only advances through exact-tic
steps and stays paused while the policy thinks. Expect the game to look
stop-motion in combat: every Jev consultation holds the world for its
latency (~160 ms), so a smooth video is better made by replaying the logged
command sequence than by recording the live trial.

`autoplay_overlay.mjs` installs a panel on the runtime page's `#hud` layer
(pointer-events: none, DOM only, never touches the engine) and updates it
from two hooks: the runner's `onStep` (tic, health/armor, sector/edge, step
source) and the policy's new `onDecision` callback (mode probabilities with
the applied mode highlighted, target probabilities, fire noul, danger score,
the resulting command, the safety rules that fired, calls/overrides and cost
so far). It is on by default because it is also what the run screenshot
captures: `run-N.png` is now a page screenshot (overlay included) instead of
the canvas capture, which came back black once the level was left.

## Skill level: `--skill`

`doomctl_warp` starts the map with the engine's current `gameskill`, and the
classic launcher boots with no `-skill` argument, so trials before this option
ran at whatever `gameskill` held after boot (recorded as `run.skill` in the
report from autoplay 0.2.0 on; see "Results" for the value). `--skill 1-5`
(or `itytd`/`hntr`/`hmp`/`uv`/`nightmare`) wraps `Module.callMain` at cold
boot to pass `-skill N` to `D_DoomMain`, which is the only way to reach the
vanilla argument parser without rebuilding the WebAssembly runtime. Verified:
`--skill 5` boots with `state.skill === 4` (Nightmare).

Design, following the typesafe-ai skill guidance (code owns the workflow,
the model supplies narrow typed judgments):

| Piece | What it does |
|---|---|
| `shouldConsult` | Gate: only steps with a visible enemy or health below 40 ask the model. Everything else keeps the deterministic proposal for free. |
| `compactState` | Named-field state: player health/armor/weapon/ammo, route phase and waypoint bearing, up to 5 nearest visible enemies with distance and bearing (positive = left). |
| `buildQuestions` | Five parallel questions over that state (policy 0.4.0): `safeToRun` noul (keep running past these enemies?), `response` choice (fight / retreat / dodge, used when the gate says no), `target` choice (one label per visible enemy + none), `fire` noul, `danger` score (safe / caution / critical). `resolveMode` folds the first two into the 4-way `mode` the mapper, logs, dashboard and overlay read: `advance` when `safeToRun >= runThreshold` (0.5), else the response; its probabilities are the joint distribution. Up to 0.3.x `mode` was a single 4-way choice. |
| state (0.4.0) | Besides health/armor/weapon, the model gets `healthLostInLast2s` with a plain-language note, `shotsLeft`, a `threat` block (how many enemies have a clear shot inside 640 units) and, per enemy, a `threat` note with vanilla damage figures and `canHitPlayerNow`. Added after UV showed the 0.3 state (a health number and names with distances) never moved the model off `advance`. |
| `answersToCommand` | Maps the answers to the same bounded ticcmd vocabulary as the follower: fight turns toward the target then holds ATTACK when aligned within 8 degrees; retreat backs off facing the target; dodge strafes; advance keeps the proposal (and fires if aligned). |
| `maxCalls` | Hard cost cap per trial; after it the policy silently stops consulting and the report shows `capped: true`. |
| safety rules | Code-owned overrides applied on top of the answers (below). |

### Safety rules (policy 0.3.0)

Code owns the safety rules; the model only supplies judgments. Three rules
were added after the first live trial (see "First live result" below):

| Rule | Trigger | Effect | Knobs |
|---|---|---|---|
| `stall` | no net progress of `stallDistance` map units across the last `stallWindow` consultations while the nearest enemy is within `meleeRange`, and that enemy is in the front half (it can block the corridor) or the player lost health during the window (it is hitting from wherever it stands) | mode forced to `fight` at the nearest enemy, fire on; logged as `forced: "fight"` and `command.rules: ["stall"]` | `stallWindow` 6, `stallDistance` 32, `meleeRange` 96 |
| `dodgeHold` | consecutive `dodge` answers | the strafe side is held for `dodgeHoldCalls` answers before flipping, so a dodge moves the player instead of cancelling itself | `dodgeHoldCalls` 4 |
| `pointBlank` | a target within `pointBlankDistance` | fired at when aligned whatever the `fire` noul says; never turns the player (see below). The noul threshold is 0.4 (it hovered at 0.45 for an Imp in the player's face) | `pointBlankDistance` 96, `fireThreshold` 0.4 |

`policy.rules` in the report counts how often each rule fired.

The consult gate (`shouldConsult`) opens for an enemy in view, health below
`lowHealth`, an enemy inside `meleeRange` outside the view cone, or a health
drop since the previous step; `compactState` includes in-reach enemies too,
so the stall rule can see a monster clawing from the side.

Two versions of these rules failed before the current one, and the failures
are worth keeping:

- A `pointBlank` that turned the advancing player toward an unaligned
  in-reach enemy stalled the follower on a Zombieman *behind* the player;
  the stall rule then forced a fight with it, `fight` stops movement, so the
  stall sustained itself and the edge tic budget ran out. All three runs of
  that trial failed identically at edge `7:54:385`, tic 619: a rule-driven
  failure is deterministic where a model-driven one is not.
- A stall rule keyed only on "in reach + no progress" had the same
  self-sustaining problem. The front-half / hurt condition is what breaks it:
  a monster behind a moving player is never fought.

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

What this said about the policy, not the model: the code owns the safety
rules, and three were missing. They became the `stall`, `dodgeHold` and
`pointBlank` rules of policy 0.3.0 (see "Safety rules" above).

### Second live result (policy 0.3.0 with safety rules, jev-1.13.0)

```text
baseline (no policy)   CLEARED, 1167 tics, damage 33, min health 67, kills 0
jev policy 0.3.0       CLEARED, 1136 tics, damage 18, min health 82, kills 1
                       155 calls, 9 overrides (8 aligned shots, 1 point-blank,
                       1 stall-forced fight), 155k input tokens, ~$0.0065
verdict                better: damageTaken 33 -> 18; tics -31; deaths 0 = 0
modes chosen           advance 155 (no dodge/fight/retreat answers this run)
```

Better than the baseline on every ranked metric. Note what did the work: the
model answered `advance` at every consultation, so the gain came from the
code-owned rules and the lower fire threshold letting the aligned shots
through, not from a change of tactic. Jev answers are not deterministic, so
this was one sample; the 3-run trials below are the stability check.

### 3-run trials (policy 0.3.x, skill 0, `npm run autoplay:e1m1:jev:x3`)

```text
rules v1 (view-cone gate)      cleared 2/3   damage 12 / 64 / 12   tics 1165 / 1204 / 1165
                               run 1: Imp clawed from outside the view cone for
                               250 tics, gate shut, no rule could fire
rules v2 (widened gate, turn)  cleared 0/3   all three identical: edge 7:54:385, tic 619
                               rule-driven stall on a Zombieman behind the player
rules v3 (front-half / hurt)   cleared 3/3   damage 27 / 27 / 26   tics 1206 / 1206 / 1195
                               baseline: damage 33, tics 1167 -> better on damage,
                               ~30 tics (0.9 s) slower; 184-201 calls, ~$0.008 per run
```

v3 is the current policy. It is the first version that clears every run, and
it beats the baseline on the ranked metrics (deaths 0 = 0, damage 26 < 33),
paying about a second of clear time for the fights it picks (13-25 stall
hits and 1-13 point-blank shots per run). The best single runs of v1 were
better (12 damage) but v1 failed one run in three; a policy that cannot lose
a run beats one with a better average, which is what the lexicographic
objective encodes.

All of the above ran at **skill 0** (the launcher boots without `-skill`, so
`gameskill` stayed at its zero initial value). E1M1 on that skill is easy
enough that the baseline clears it without shooting, so the policy's margin
here is small by design.

### Ultra-Violence (skill 3, `--skill uv`)

```text
baseline (no policy)   FAILED player_dead at edge 60:56:194, tic 792, kills 5
                       health 61 -> 0 in the courtyard (sectors 71/60, 6 enemies in view)
jev policy 0.3 v3      FAILED 3/3: died at 72:74:309 (tic 947, 8 kills) and twice at
                       60:56:194 (tic 869, 4 kills); 216-221 calls, ~$0.0125 per run
modes answered         advance 215-220 of 216-221 per run; dodge once; fight/retreat never
rules fired            stall 32-71, pointBlank 7-28 per run
```

At UV the route follower cannot outrun E1M1 any more, and the policy does
not add a tactic: Jev answered `advance` at practically every consultation,
so every shot fired came from the code-owned rules, and those only fire when
already aligned or after a stall. The player was shot to death by shotgun
guys at 40-130 units while advancing or while the route follower turned in
place (geometric `turn` steps with no override, because `advance` + not
aligned keeps the proposal). This is the first result where the model's
judgment, not a missing rule, is the limiting factor.

Averaged over the 658 UV consultations the `mode` probabilities were
advance 0.73, dodge 0.22, fight 0.05, retreat 0.00, and they did not move
with three or more enemies in view (646 of the 658). `danger` reached the
critical band (>= 1.5) 12 times. The argmax mapping then turns a steady
0.73 into `advance` every single time.

Next steps, in order of expected effect (1-3 became policy 0.4.0, results
below):

1. **State**: add what makes the danger visible. Health lost over the last
   ~2 s, how many enemies have line of sight and are within firing range,
   a per-type threat note (a shotgun guy at 50 units is the E1M1 killer),
   and the weapon's ammo as "shots left". Today the model sees a health
   number and a list of names with distances.
2. **Questions**: replace the argmax over four modes with a gate. Ask a
   `noul` "is it safe to keep running past these enemies right now?" and
   only when it says no ask which of fight / retreat / dodge; a 0.27 mass
   on "not advance" is a signal the argmax throws away.
3. **Prompt bias**: the mode context says running past is free when
   enemies are far or behind; at UV they are neither. Drop that sentence
   and let the state carry it.
### UV with policy 0.4.x (gate question, threat state) and a combat budget

Each version ran the same 3-run UV trial against the UV baseline (dies at
tic 792). One iteration per row; every failure mode is in the logs.

```text
0.4.0  gate + threat block           0/3  edge budget at 3:4:151 (tic ~500)
       safeToRun followed the "shooters" count, which flipped 0/1 as a
       shotgun guy crossed a single 640-unit cut-off -> advance/retreat
       oscillation in place, 0 deaths, 0-58 damage
0.4.1  per-type effective range,     0/3  edge budget at 7:54:385 (hangar), 21-33 damage
       retreat guard, hysteresis         retreat 67 of 111 answers; fight target
                                         re-picked "nearest" each step -> aim thrash
0.4.2  sticky target, hitscanFight,  0/3  edge budget at 7:54:385, 72 damage, 3 kills
       0.08 turn floor                   115 of 156 fight steps spent aiming:
                                         measured 7.0 deg per turn unit per tic,
                                         so 0.08 x 1 tic = 0.5 deg
0.4.3  exact aim (aimStep)           0/3  edge budget at 7:54:385, 45 damage, 5 kills
                                         fights now end; the 280-tic route budget
                                         (baseline needs 133 there running) does not
                                         leave room for 4-5 shotgun guys with a pistol
0.4.3 + combat budget                1/3  run 0 CLEARED: 1779 tics (50.8 s), 87 damage,
       (--max-combat-tics 600,           min health 13, 19 kills, 480 calls, $0.028
       fight/retreat steps counted       runs 1-2 died in the courtyard (60:56:194),
       apart from --max-edge-tics)       the baseline's death spot, at 43-44 hp after
                                         the hangar cost 51-63 hp
```

The first UV clear where the baseline dies: `better: cleared where the
baseline did not`. It was 1 in 3, at 13 hp, and 1.4x the skill-0 clear
time. The hangar edge (`7:54:385`, 4-5 shotgun guys in the open) cost 51-63
hp with a pistol whichever policy version fought it; the courtyard then
finished a player who arrived under ~45 hp.

```text
0.5.0  shotgun loot                  3/3  CLEARED: 1699 / 1603 / 1673 tics (46-49 s),
       (walk over the shotgun a           damage 41 / 42 / 54, min health 60 / 59 / 47,
       killed shotgun guy drops)          16 kills each, 255-283 calls, $0.016-0.018 per run
                                         loot picked 2/2 in every run, ~21 tics per pickup
                                         hangar edge now costs 24 hp (94 -> 70) instead of 51-63
```

### Loot rule (policy 0.5.0)

The map's own shotgun (`THINGS` doomednum 2001 at 3264,-3936) lies in a
secret area off the route, but at UV sixteen shotgun guys each drop a
shotgun where they die. When `player.kills` rises while the pistol is out
and the last fight target was a shotgun guy, the policy turns its last
polar position (player pose + distance/bearing) into a world waypoint and
walks there for at most `lootTimeoutTics` (140, 4 s), spending no API
calls. It ends on pickup (shells rise or the weapon switches to 2), on
arrival with nothing there, or on the timeout; `jev.jsonl` gets
`loot_start` / `loot_end` rows and `policy.rules` counts `lootSteps`,
`lootPicked`, `lootGivenUp`. The first pickup lands at tic ~376 in every
run, right after the first shotgun guy on the route, so the hangar is
fought with a shotgun.

### The remaining two candidates, and what the re-run taught

```text
0.5.1  cover (back up to the edge     1/3  run 0 died on the courtyard approach with
       entry point when fighting          76 -> 31 -> 4 hp spent in cover mode; run 2 hit
       2+ shooters) + lowHealthHold       the route budget in the hangar; cover fired 6-16x
0.5.2  cover off, lowHealthHold on    0/3  functionally identical to 0.5.0 (lowHealthHold
                                         fired 0 times, cover 0); died at 72:74, 71:60, 73:72
                                         after 10-17 kills; hangar edge cost 51-78 hp
                                         where 0.5.0's runs had paid 24
```

Two conclusions, the second more important than the first.

`cover` as written is harmful and is off by default. The edge entry point
is where the previous edge ended, not a doorway in the line-of-sight
sense, so backing up to it kept the player in the open while facing fire.
A real version needs map LOS geometry (which sector lines block sight from
the enemies' positions), which the policy does not have today.
`lowHealthHold` never triggered in six runs: when health is under 40 the
mode is already `fight`, so the rule guards a case that does not occur.

**Three runs are not enough to rank policy versions.** 0.5.0 and 0.5.2 are
the same policy in effect and scored 3/3 and 0/3; pooled, 3 clears in 6.
The hangar fight's cost with identical code ranged from 24 to 78 hp
because Jev's answers differ run to run and each different command
sequence meets a different roll of DOOM's damage table (a shotgun blast is
3-45). Every "better/worse" verdict above that rests on one 3-run trial,
0.3 v3's 3/3 at skill 0 included, carries that uncertainty. For the next
decisions: at least 10 runs per version at UV (~$0.20), report the clear
rate with its binomial interval, and compare the per-edge damage
distributions of the hangar and courtyard edges rather than the best run.
A rules-only control (`shouldConsult` always false, the safety rules
still active) is the other missing measurement: it separates what the
model contributes from what the code contributes.

### 10-run trials and the rules-only control (UV, policy 0.5.2)

`autoplay_compare.mjs` over the three UV trials (`npm run autoplay:compare:uv`):

```text
trial               policy  runs  cleared      95% CI   damage med  hp lost @hangar  hp lost @courtyard  deaths at
baseline            none     1    0/1  (0%)    0-79%    100         27               40 (died)           courtyard x1
rules-only control  rules   10    0/10 (0%)    0-28%    100         27 (all 10)      7 (died, all 10)    courtyard x10, identical runs
jev                 jev     10    2/10 (20%)   6-51%    100 [33-101] 54 [27-72]      16 [0-43], 7 reached  courtyard x4, hangar budget x2, 54:53 x1, 75:76 x1
```

Pooled over every 0.5.x UV run (0.5.0 3/3, 0.5.2 0/3, this 2/10): 5 clears
in 16, a 31% rate with a 95% interval of roughly 14-56%. That is the
honest number for "the current policy at Ultra-Violence", and it is what
the earlier 3/3 was a lucky draw from.

What the control shows. With the model replaced by fixed answers the
policy is deterministic: ten identical runs, ten deaths in the courtyard at
tic 1012 after 10 kills. The code rules on their own (point-blank shots,
stall fights, loot) do not clear UV; every clear so far had Jev in the
loop, so the model is contributing, even though its answers are mostly
`fight` (1684 of 2706 modes in the 10 runs) and the clear rate is low.

What costs the runs. Fighting the hangar costs a median 54 hp (27-72);
running through it, as the control and the baseline do, costs 27. But the
runner-through arrives in the courtyard at ~40 hp with a pistol and dies
there every time, while the fighter arrives with a shotgun and 20-70 hp and
survives it 7 times in 10. So the hangar fight is the right call and its
price is the lever: the two clears lost 27 and 45 hp there, the deaths 54-72.
Reducing that spread (which enemy to shoot first, whether to fight from
the corridor before the hangar opens up) is the next tuning target, and it
has to be judged on 10-run damage distributions, not on a best run.

### Policy 0.6.0: map item loot and threat-first targeting (UV, 10 runs)

```text
trial                 cleared     95% CI   hangar hp lost   courtyard hp lost   deaths / budget
0.5.2 (10 runs)       2/10 (20%)  6-51%    54 [27-72]       16 [0-43], 7 reached  courtyard x4, hangar budget x2, other x2
0.6.0 (10 runs)       2/10 (20%)  6-51%    54 [24-94]       12 [0-24], 5 reached  hangar dead x1 + budget x3, courtyard x1, other x3
```

No change in clear rate; the failures moved from the courtyard to the
hangar. The audit of `loot_end` rows says why: of 7 health detours 2
picked and 5 ended `blocked` (no progress, a wall between the player and
the item), of 9 shells detours 2 picked and 7 blocked. Items are targeted
in a straight line and the map's pickups mostly sit in alcoves and side
rooms; the 371 loot steps in 10 runs (~37 per run) were spent on route
budget, and three runs exhausted the hangar edge's route budget where 0.5.2
lost two. `threatTarget` fired once in 10 runs: the sticky target rule
takes precedence and almost every fight already has a locked target.

Kept: the shotgun drop loot (16/16 picked). Health and shells loot need
reachability (same sector, or a sector-route check through the navigation
graph) before they help; straight-line loot is off by default from 0.6.1.
Threat-first targeting stays on; it costs nothing and applies when a fight
starts without a lock.

```text
0.6.1 (10 runs)       1/10 (10%)  2-40%    51 [36-94]       5 [0-20], 4 reached   hangar route budget x5 (3 of them at 52 hp), courtyard x1, other x4
```

Same-sector loot fired twice in ten runs (both after the courtyard) and
changed nothing upstream. 0.5.2 / 0.6.0 / 0.6.1 are statistically the same
policy at 2/10, 2/10, 1/10. What 0.6.1 did expose is the runner: five runs
ended on the hangar edge's *route* budget, three of them with the player
at 52 hp and the fight going well. Advancing-while-shooting and aiming
steps count as route tics, so a policy that fights its way across a long
edge is cut off by a budget sized for a runner that never stops.

The budget's job is to detect a stuck follower, so from autoplay 0.3.0 it
counts **tics without progress**: the edge fails when `--max-edge-tics`
pass without the distance to the portal reaching a new minimum, and the
exit approach likewise. Total tics are unchanged and still ranked by the
objective. Trials before this change are not comparable on the
budget-failure rows.

```text
0.6.1 + progress budget      1/10   7 runs cut at 70 hp: the no-progress budget counted standing
  (runner 0.3.0, first cut)         fights; and with 1 shell the model answered fire 0.2 and the
                                    player stood aligned and silent for 130 tics
0.6.2 (fightFires; combat    1/10   8 of 10 runs tic-identical (1294 tics, 17 kills): standing
  steps outside the                 in the exit corridor trading shots with one zombieman ahead
  no-progress budget)               while another shot from behind (-128 deg). The clear (run 6)
                                    is the best UV run so far: 24 damage, min health 76, 1338 tics.
```

Six policy versions at UV (0.5.2 through 0.6.2) sit at 1-2 clears in 10.
Each rule fixed the failure it was written for and the runs then failed
somewhere else, and whenever a rule decided most steps the runs became
tic-identical: the model was no longer steering. The productive next step
is not another rule. It is either (a) give the model the decision the
rules keep taking, with better state (an enemy-behind flag, "you are
standing still", shots fired without effect), and measure whether its
answers change; or (b) accept the rules as the policy and tune them on
the 10-run damage distributions. Both are measurable with the tools here.

Clear time (38-62 s on cleared UV runs vs the skill-0 baseline's 33 s)
stays the metric after damage variance is under control.

### Skill levels side by side (policy 0.6.2, runner 0.3.0)

E1M1 monster placement by THINGS skill bits: skill 0-1 has 4 monsters
(2 zombiemen, 2 imps), HMP 6 (4 zombiemen, 2 imps), UV/NM 29 (9 zombiemen,
16 shotgun guys, 4 imps). Skill 0 additionally halves damage taken.

```text
skill            baseline (no policy)                        jev 0.6.2, 10 runs
0  ITYTD         CLEARED, 33 damage, 1167 tics               (0.3 v3: 3/3, 26-27 damage)
2  HMP           dies in the exit corridor (72:74:309),      10/10 (95% CI 72-100%), damage 15 [0-24],
                 tic 965, 0 kills                            min health 76-100, 5 kills each, 1464-1880 tics
                                                             (median 1568, 45 s), $0.015 per run
3  UV            dies in the courtyard (60:56:194)           1/10 - 2/10 across six versions
```

The HMP baseline dies with six monsters on the map because HMP deals full
damage: the same corridor imp that costs 33 hp at skill 0 costs 100 here.
The policy clears HMP every time, and cleanly: the exit corridor and the
hangar cost 0 hp in all ten runs; the damage that remains (0-24) is spread
over the route. `fightFires` (117), `stall` (21) and `noRetreatFar` (17)
are the rules that fired; loot never triggered (no shotgun guys to drop
one, health never dropped far enough).

So the policy's competence boundary on E1M1 lies between HMP and UV: it
handles "a few hitscan enemies and an imp in a corridor" reliably and
"sixteen shotgun guys in an open hangar with a pistol" one time in ten.
HNTR (skill 1: the 4-monster layout at full damage) has not been run.

## E1M2: what layer 1 needed to learn

`--map E1M2` failed at planning with `no_reachable_exit`. Four gaps, all
in the deterministic layer, none in the policy:

| Gap | Symptom | Fix |
|---|---|---|
| Tagged (remote) doors | sector 124 is closed (ceiling on floor), tag 12; the switch that opens it is line 777 (special 103, S1 open-stay) in sector 120. The graph knew only doors with the special on the door line itself. | `REMOTE_DOOR_SPECIALS` (2/4/29/61/63/86/90/103/108-114) become **trigger pseudo-edges**; a closed tagged sector some trigger opens is a `door/remote` edge with `requiredTag`. The progression tracks fired tags next to keys; `activateTrigger` walks to the line, uses it and waits for the door sector to open. |
| Key pickup | the route enters the red key's sector (62) and leaves; sector-level routing never walked over the key | `collectKey` walks to the key thing after entering its sector; the engine state has no keycard field, so arrival within 28 units is the success test |
| Skip-ahead on a looping route | E1M2 goes out for the key and back through the start sector. "Already in a later route sector" saw the start sector at position 32 and skipped the whole key detour in 0 tics, then died at the red door | skipping is bounded by the next key / trigger step and only looks forward |
| Non-convex sectors | the start room's straight line from the player to the door portal ran into an inner corner (walls x=128 and y=-96) and a barrel; the follower stalled for 390 tics | `planLocalPath`: a visibility graph over the sector's wall corners (pushed 36 units inward) with a **capsule** walkability test (player radius against walls and solid things); `navigateEdge` and the approach helpers follow its waypoints, replanning on a stall |

Result: E1M2 clears in god mode (3182 tics, 91 s; red key, switch,
remote door, exit lift). E1M1's plan is unchanged (20 transitions).

Two things to know. First, E1M1's god-mode reference run changed: local
routing shortens the route (the exit corridor is reached at tic 974
instead of 1063) and at that timing an imp stands in the corridor; the
deterministic follower has no way past a monster body and now fails that
run with `edge_no_progress`. Policy runs handle it (the stall rule forces
a fight), so this is a documented layer-1 limit, not a regression in
what the policy is measured on. Second, the E1M2 HMP baseline
(`npm run autoplay:e1m2:hmp:baseline`) **clears** with 183 damage taken:
the route crosses several health pickups (health rises 20 -> 95 once),
so on E1M2 the policy is measured on damage and time, not on clearing.

### E1M2 at HMP, policy 0.6.2, 10 runs

```text
                         cleared     95% CI   damage (cleared)   tics (cleared)      failures
baseline (no policy)     1/1                  183                3247
jev 0.6.2, before lift   3/10 (30%)  11-60%   69 / 120 / 126     3524-3795 (100 s)   6 of 7 on the lift edge 137:121
  rules                                                                              (no progress x3, died on it x3),
                                                                                     1 on the exit lift 49:48
```

The cleared runs beat the baseline on damage by 57-114 hp. The failures
were one mechanism: sector 137 is a lift (floor 248 -> 0). The follower
rides it down in 27 tics; the policy, seeing four enemies below, answered
`fight` on the platform (forward 0), the lift cycled back up, and when it
came level again the fight command replaced the walk-off. Fix in layer 1:
`navigateEdge` reads the platform's live floor; away from the target
floor it calls the lift (USE on switch lifts) and holds, and when the lift
is level the walk-off command outranks the policy for that step (a transit
step the model does not get). E1M2 god mode with the rules: 3005 tics,
all five lift edges pass. The 10-run re-trial is below.

```text
                          cleared     95% CI   damage (cleared)     failures
lift rules v1             5/10 (50%)  24-76%   72-129, median 120   exit lift 49:48 x2 (USE from the platform does
  (call / hold / leave)                                             nothing: its trigger is the walk-over line),
                                                                    121:120 x3 (a fight pushed the player back
                                                                    onto the lift, which rose with it)
lift rules v2             7/10 (70%)  40-89%   72-144, median 102   exit lift 49:48 died x2 (walk-off blocked by a
  (+ re-cross a walk-over                                           monster in the portal while the walk-off
  trigger, + route-position                                         outranked the policy), trigger 777 died x1
  recovery)
```

Each lift version removed the failure it targeted and exposed the next
one. v3 bounds the walk-off priority to six steps (then the policy, whose
stall rule fights a blocker, gets the step back) and lets a stationary
fight override stand while waiting on the platform.

```text
lift rules v3             9/10 (90%)  60-98%   69-180, median 126   121:120 died x1 (10 kills, on the way
  (walk-off priority for                                            down from the lift)
  6 steps, stationary
  fights allowed while
  waiting)
```

E1M2 at HMP with synchronous consultation: 9 of 10 runs clear with the
policy (95% interval 60-98%), damage 69-180 against the baseline's 183, at
1.1-1.4x its time (3595-4437 tics, 103-127 s), $0.02 per run. The whole
improvement from 3/10 came from layer 1 (lifts, keys, triggers, local
routing, route recovery); the policy itself is unchanged since 0.6.2.

## Pipelined consultation (`--jev-pipeline N`)

A watched run stutters because every consultation holds the world for the
model's latency (~166 ms, about 6 tics) before the next 3-4 tics run. With
`--jev-pipeline N` the request for a step's state is sent without waiting;
the world keeps stepping, and the answer is applied N tics later, waiting
only if it has not arrived by then, so a trial is still a function of the
answers rather than of the network. Between arrivals the latest decision
is re-applied to the current state, and a new request launches only when
none is in flight, which also spaces the calls out (the "consult less
often" lever, `--jev-min-steps`, is available on top of it but was not
needed).

E1M2 at HMP, 10 runs each, same policy 0.6.2:

```text
                    cleared   damage (cleared)     tics (cleared)     calls/run  cost/run  world pauses/run
synchronous         9/10      126 [69-180]         3879 [3595-4437]   359        $0.020    359 (one per call, ~166 ms each)
pipelined, lag 8    10/10     105 [69-150]         4167 [4005-4782]   152        $0.009    1 (avg 83 ms)
```

The pauses are gone (one short stall per run when an answer takes longer
than the lag), calls and cost halve because a request is only launched
when the previous one has landed, and the clear rate and damage did not
suffer: 10/10 and a lower median. The price is a ~7% longer clear time
and decisions made on a state that is, on average, older than the nominal
8 tics (22.9 tics measured, because an answer that lands after a fight
ends is applied at the next consulted step). Two runs of the ten were
tic-identical, which says the pipelined policy leans a little more on the
rules than the synchronous one; watch that if it grows.

This is now the recommended mode for `--headed` watching
(`autoplay:*:watch` scripts pass `--jev-pipeline 8`).

Note on determinism: with 0.4.2 and 0.4.3 all three runs were tic-identical
(the rules decided every step), while the combat-budget trial's runs
diverged again (Jev's answers mattered). A policy whose runs are identical
is a policy the model is not steering.

4. **Mapping**: `advance` + not aligned currently keeps the route
   follower's slow turn-in-place while being shot; a code rule that fights
   the nearest enemy with line of sight when health dropped in the last
   window (not only when stalled) would cover the geometric turning steps.
5. **Skill 2 (HMP)** as the intermediate benchmark: UV kills the baseline
   outright, so there is no partial-credit signal there yet.

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
