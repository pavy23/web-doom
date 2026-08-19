# P2.1 — Deterministic Game-Design Evaluator

P2.1 adds a repeatable design-analysis layer on top of P2.0 source-free level generation.

It deliberately does **not** claim to measure whether a level is objectively fun. The evaluator produces deterministic proxy metrics that are useful for AI iteration, regression testing and before/after comparison. P0 validation, LinuxDOOM runtime QA and real playtesting remain separate acceptance layers.

## Evaluation flow

```text
P2.0 generated/editable session
        ↓
P0 deterministic validation
        ↓
pinned ZDBSP build/export
        ↓
P2.1 built-candidate evaluation
        ↓
structured scores + issues + recommendations
        ↓
AI applies another atomic P2 edit batch
        ↓
rebuild
        ↓
before/after comparison
```

Only built/exported PWAD candidates are scored by the MCP evaluator. This prevents an invalid draft geometry state from being presented as a meaningful game-design score.

## Components

Every report has six 0–100 component scores:

- `reachability` — how much of the sector graph is reachable from Player 1 when placed keys are available
- `progression` — exit presence, key-aware exit reachability and path depth
- `topology` — loops, branch sectors, dead ends and average graph degree
- `combat` — normalized threat density, encounter coverage, concentration and path volatility
- `resources` — normalized support/threat ratio, early weapon access, health support and pickup distribution
- `pacing` — path depth, start-room pressure, threat concentration and coarse early/late escalation

The weighted total is a deterministic design proxy, not a runtime success condition.

## Profiles

P2.1 includes three policy profiles:

- `balanced`
- `combat`
- `exploration`

Each profile changes component weights and target heuristic ranges. The same map can therefore score differently under different design briefs without changing the underlying measurements.

The evaluator also filters THINGS by `easy`, `medium` or `hard` skill flags and ignores multiplayer-only THINGS for this single-player P2.1 policy.

## Threat and resource normalization

Classic Doom monster and pickup types are assigned intentionally simple normalized weights. These weights are not claims about exact damage-per-second or expected player health loss. They make comparisons repeatable.

Examples of high normalized threat include Cyberdemon and Spider Mastermind; ammo, weapons, health, armor and selected powerups contribute normalized support.

The strongest use is therefore:

```text
same map family + same profile + same skill + same policy version
→ compare before/after deltas
```

rather than comparing unrelated levels as if the score were an objective ranking.

## Structured issue codes

Current evaluator findings include:

- `NO_PLAYER1_START`
- `NO_EXIT`
- `EXIT_UNREACHABLE`
- `UNREACHABLE_SECTORS`
- `TOPOLOGY_TOO_LINEAR`
- `TOO_MANY_DEAD_ENDS`
- `COMBAT_EMPTY`
- `THREAT_OVERCONCENTRATED`
- `RESOURCE_STARVATION`
- `RESOURCE_OVERSUPPLY`
- `NO_EARLY_WEAPON`
- `START_ROOM_OVERPRESSURED`
- `MAIN_PATH_TOO_SHORT`

Each finding includes a suggested follow-up action, but P2.1 does not silently apply those edits.

## MCP entry point

```text
mcp/p2_game_design_server.js
```

New tools:

- `doom_p2_game_design_status`
- `doom_get_game_design_policy`
- `doom_evaluate_game_design`
- `doom_compare_game_design`

The P2.0 server is composed underneath P2.1, so blank-map creation, atomic authoring, build, navigation, repair and runtime trial tools remain available from the same MCP process.

## Example loop

```text
Create a source-free E1M1.
Author rooms, enemies and pickups.
Validate and build as candidate-a.wad.
Evaluate candidate-a.wad with profile=balanced, skill=medium.
Apply one atomic edit batch based on the highest-severity findings.
Validate and build as candidate-b.wad.
Compare candidate-a.wad and candidate-b.wad under the same policy.
Do not call the result better until runtime QA still passes.
```

## Acceptance regression

The P2.1 self-test deliberately creates a valid two-sector generated E1M1 with one Cyberdemon and no authored support. It then proves:

1. repeated evaluation is byte-for-byte deterministic as a JS report;
2. the weak candidate reports resource starvation and no early authored weapon;
3. adding shotgun, ammo, health and armor through a P0/P1 transaction increases the resource component;
4. overall score increases under the same policy;
5. `RESOURCE_STARVATION` and `NO_EARLY_WEAPON` resolve;
6. the before/after comparator reports the resolved findings and positive delta;
7. different profiles interpret the same measured map differently.

## Next

P2.2 can reuse this evaluator architecture for deathmatch-specific metrics:

- Player 1–4 / deathmatch start coverage
- pairwise spawn distance fairness
- spawn-to-weapon travel distance
- immediate line-of-sight exposure
- central high-value item risk/reward
- alternate-route count
- chokepoint and camping advantage
- item symmetry/asymmetry

Online networking remains a separate P3 runtime milestone.
