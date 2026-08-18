# Web DOOM — Direct LinuxDOOM + AI Authoring MCP v2.1 P0

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended into an AI-native level-authoring, structural-geometry, deterministic playtest/evaluation and multi-map experiment sandbox.

The `/direct/` runtime uses the original LinuxDOOM gameplay/rendering/WAD code with repository-owned browser platform adapters. Chocolate Doom is used only for the pinned Vanilla/DMX-compatible OPL music subsystem, not as the game runtime.

## Play

- Direct build: https://pavy23.github.io/web-doom/direct/
- Earlier doomgeneric comparison build: https://pavy23.github.io/web-doom/
- Stable direct-port development branch: `direct-linuxdoom`
- P0 development branch: `p0-episode-authoring`

Current MCP version on the P0 branch: **2.1.0-p0.1**

## P0 status — complete

P0 adds the reliability layer required before expanding the AI authoring surface further.

```text
AI edit request
      ↓
selected map set
E1M3 only / E1M1+E1M4 / E1M1..E1M8 / MAP##
      ↓
atomic transaction
      ↓
full changed-topology validation
      ↓
pinned + hash-verified ZDBSP WASM per map
      ↓
verified multi-map PWAD
      ↓
structural cold boot in LinuxDOOM
      ↓
exact-tic browser experiment
      ↓
telemetry + PNG evidence + PASS/FAIL report
```

P0 consists of four main pieces:

1. **Full topology validation** — detects AI-introduced crossings, collinear overlap, T-junctions, duplicate geometry, orphan primitives, two-sided linedef inconsistencies and affected-sector manifold/self-intersection failures. Moving a legacy vertex is included in the changed-geometry pass.
2. **Atomic multi-map transactions** — the complete selected map set is snapshotted before mutation. If any edit fails, earlier edits in other maps are rolled back too.
3. **Multi-map build pipeline** — each selected map is independently validated and rebuilt through pinned ZDBSP, then packaged into one PWAD.
4. **Automated browser experiment runner** — a dedicated headless Chromium cold-boots the candidate, warps through requested maps, executes exact world tics, captures telemetry/PNG evidence and writes a PASS/FAIL report.

Vanilla zero-height sectors (`floor == ceiling`) are preserved as valid Doom map structures. Actual inverted sectors remain invalid.

## Selected-map and full-episode authoring

The P0 map-set layer is **not limited to the whole episode**.

Single map:

```json
{
  "maps": ["E1M3"]
}
```

Selected maps:

```json
{
  "maps": ["E1M1", "E1M4", "E1M7"]
}
```

Whole Episode 1:

```json
{
  "maps": ["E1M1", "E1M2", "E1M3", "E1M4", "E1M5", "E1M6", "E1M7", "E1M8"]
}
```

If `maps` is omitted by the automated experiment runner, it defaults to **E1M1 through E1M8**.

The map-name layer also accepts `MAP##`, keeping the same transaction/build architecture usable for later DOOM II-style and multiplayer map-set generation. A requested map must currently exist in the source/candidate WAD; generating a completely new map marker from an empty map is future work.

## P0 episode MCP tools

Map-set/session tools:

- `doom_p0_status`
- `doom_begin_episode_session`
- `doom_get_episode_session`
- `doom_get_episode_map`
- `doom_validate_episode`

Atomic transaction tools:

- `doom_begin_transaction`
- `doom_apply_transaction_edits`
- `doom_validate_transaction`
- `doom_commit_transaction`
- `doom_rollback_transaction`

Episode build/restore tools:

- `doom_build_episode`
- `doom_restore_episode_baseline`
- `doom_restore_episode_candidate`
- `doom_finalize_episode`

Automated experiment tools:

- `doom_run_episode_experiment`
- `doom_get_episode_experiment_report`

The transaction edit surface currently composes structural operations such as room/corridor creation, sector-height edits, vertex movement and low-level geometry primitives across any selected maps.

## Automated episode experiment runner

`doom_run_episode_experiment` can test either a newly built candidate or an already exported PWAD.

Minimal full-episode pipeline smoke test:

```json
{
  "autoEditProfile": "safe-height-nudge"
}
```

The `safe-height-nudge` profile deliberately changes one ordinary sector in every requested map. It exists only to prove the complete mutate → validate → build → boot → test pipeline and is **not** a level-design policy.

Test only one map:

```json
{
  "maps": ["E1M3"],
  "autoEditProfile": "safe-height-nudge"
}
```

Regression-test an existing episode PWAD:

```json
{
  "candidateFilename": "episode1-ai.wad",
  "maps": ["E1M1", "E1M2", "E1M3"]
}
```

Custom deterministic action plans can be supplied per map:

```json
{
  "maps": ["E1M1", "E1M2"],
  "candidateFilename": "episode1-ai.wad",
  "actionsByMap": {
    "E1M1": [
      { "forward": 0.7, "tics": 35 },
      { "turn": 0.4, "tics": 18 }
    ],
    "E1M2": [
      { "forward": 0.5, "attack": true, "tics": 50 }
    ]
  }
}
```

Experiment evidence is written under:

```text
mcp/exports/experiments/<experiment-id>/
  config.json
  report.json
  E1M1.png
  E1M2.png
  ...
```

Default PASS/FAIL checks cover runtime/map readiness, exact world-tic advancement, player survival/health, visited sectors and valid PNG capture. Per-map expectations can additionally set `maxDeaths`, `minHealth`, `minDistanceUnits` and `minVisitedSectors`.

Detailed runner guide: `mcp/P0_EXPERIMENT_RUNNER.md`.

## v2 structural geometry tools retained by P0

Semantic operations:

- `doom_geometry_add_room` — extrude a rectangular room from a safe one-sided wall
- `doom_geometry_resize_room`
- `doom_geometry_delete_room`
- `doom_geometry_add_corridor` — connect two facing, parallel, equal-span one-sided walls
- `doom_geometry_set_sector_heights`

Low-level primitives:

- `doom_geometry_add_vertex`
- `doom_geometry_move_vertex`
- `doom_geometry_add_sector`
- `doom_geometry_add_sidedef`
- `doom_geometry_add_linedef`
- `doom_geometry_undo`

Session / validation:

- `doom_geometry_status`
- `doom_geometry_prepare_nodebuilder`
- `doom_begin_geometry_session`
- `doom_get_geometry`
- `doom_geometry_validate`
- `doom_geometry_build`
- `doom_geometry_restore_baseline`
- `doom_geometry_restore_candidate`
- `doom_geometry_finalize`

The AI never writes BSP nodes directly. Structural edits must pass deterministic validation and a node-builder pass before LinuxDOOM loads them.

## Retained authoring and playtest capabilities

Earlier MCP layers remain available beneath P0:

```text
actors / enemies
sector lighting
wall / floor / ceiling materials
door + trigger behavior
PWAD export / reload
PNG vision + telemetry
exact-tic simulation
autonomous ticcmd player input
design-goal evaluation
bounded closed-loop revisions
live cheats + audio diagnostics
```

Closed-loop design sessions remain available:

```text
design goal
→ bounded semantic edits
→ candidate PWAD
→ autonomous exact-tic playtest
→ PNG + telemetry
→ deterministic evaluation + optional AI vision rubric
→ revise / restore
→ final PWAD
```

Runtime-only debugging tools include god mode, noclip, full arsenal/ammo/keys, health/armor, power-ups, map warp and browser/SDL audio diagnostics. These cheats are not serialized into authored PWADs.

## Node builder

Structural authoring uses immutable artifacts from `seanmorris/zdbsp-wasm` commit:

```text
acc45bf6b2232a75bdbb0b6295822e72e13dfeec
```

The wrapper and WASM binary are cached under `mcp/.cache/zdbsp/` and checked against their exact Git blob SHA before execution.

The vanilla-compatible node build uses:

```text
--zero-reject
--no-prune
--map=E#M#
```

Each map gets ordinary Doom nodes/blockmap and a full-sized zero `REJECT` table rather than a ZDoom-only empty representation.

## Architecture

```text
LinuxDOOM 1.10 / WASM
        │
        ▼
Browser DoomControl
        │
 ┌──────┼────────┬────────┬────────┬────────┐
 │      │        │        │        │        │
3777   3778     3779     3780     3781
control playtest orchestrate cheats geometry
 │      │        │        │        │
 └──────┴────────┴────┬───┴────────┘
                     ▼
            P0 MCP composition
        p0_experiment_server.js
                     │
       ┌─────────────┴──────────────┐
       ▼                            ▼
EpisodeWorkspace             headless Chromium
transactions                 experiment runner
validation                    exact-tic QA
ZDBSP × selected maps         PNG + telemetry
       └─────────────┬──────────────┘
                     ▼
                  stdio MCP
                     │
          Grok / Claude / Codex / etc.
```

The public Pages game behaves normally. Local MCP WebSockets activate only when the game is opened through the local MCP proxy or by the automated experiment runner.

## Quick start — P0

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout p0-episode-authoring
cd mcp
npm install
npm run prepare-experiment
npm start
```

`prepare-experiment` installs Playwright Chromium for the automated runner. The runner can also fall back to an installed Chrome where supported.

Open for interactive MCP work:

```text
http://127.0.0.1:3777/
```

and click **CLICK TO START**.

Generic MCP host configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/p0_experiment_server.js"]
}
```

Available entry points:

```text
npm start                 P0 + automated experiment runner
npm run start:p0-core     P0 authoring without experiment runner
npm run start:v2          previous v2 geometry server
```

## Example: edit one map only

```text
E1M3만 대상으로 episode authoring session을 시작해.
현재 geometry를 조사하고 기존 흐름을 해치지 않는 새 공간을 하나 추가해.
transaction으로 처리하고 topology validation을 통과시켜.
E1M3만 포함한 candidate를 build한 뒤 automated experiment로 cold-boot하고
exact-tic smoke test와 PNG/telemetry 결과를 확인해.
```

## Example: modify the whole episode

```text
E1M1부터 E1M8까지 하나의 episode workspace로 열어.
각 맵을 조사하고 서로 다른 작은 구조 변경을 적용해.
모든 변경을 하나의 atomic transaction으로 처리해.
전체 topology validation 후 각 맵을 ZDBSP로 rebuild하고 하나의 PWAD로 묶어.
그 candidate를 automated episode experiment로 E1M1~E1M8 순회 테스트해.
맵별 PNG, telemetry, PASS/FAIL을 보고해.
```

## Modern browser controls

The direct browser platform defaults to a modern FPS scheme while preserving original arrow-key behavior:

```text
W / S          forward / backward
A / D          strafe left / right
Left / Right   rotate
Up / Down      forward / backward
Mouse X        horizontal turn
Mouse Y        ignored
Click canvas   pointer lock + hide cursor
Esc            release pointer lock
Ctrl / J       fire
Space / E      use / open
Shift          run
1..7           weapon selection
```

A/D reuse LinuxDOOM's original dedicated strafe bindings; movement physics were not replaced.

## Audio

Sound effects use direct DMX type-3 decoding through SDL2_mixer.

Music follows a Vanilla/DMX-compatible OPL register path using IWAD `GENMIDI` instrumentation and Nuked OPL3 v1.8 in OPL2-compatible mode. The OPL subsystem is imported from pinned Chocolate Doom revision:

```text
410d96855b5df5410ff591a90efeafa889119224
```

LinuxDOOM baseline:

```text
a77dfb96cb91780ca334d0d4cfd86957558007e0
```

Public shareware IWAD:

- size: 4,196,020 bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

## CI / P0 completion gate

P0 has three automated validation layers:

1. `p0_selftest.mjs` — validates E1M1~E1M8, cross-map atomic rollback/commit and rebuilds all eight maps through the real pinned ZDBSP pipeline.
2. `p0_browser_e2e.mjs` — launches the real browser/WASM runtime and verifies the five local bridges on ports 3777~3781.
3. `p0_experiment_selftest.mjs` — builds an eight-map candidate, cold-boots it in Chromium, explicitly warps through E1M1~E1M8, advances exact world tics, captures PNG evidence and requires every map report to pass.

The final P0 logic CI completed successfully before this documentation update.

## Current geometry boundary

Supported safe semantic topology remains deliberately bounded: room extrusion, straight corridor connection and low-level Doom primitives. Arbitrary free-form polygon generation, automatic obstacle-routing corridors, arbitrary deletion/merging of legacy sectors, stairs/lifts as semantic primitives and general navigation are not yet treated as safe high-level operations.

The governing rule remains:

> **AI proposes topology; deterministic validation + node building decides whether it is loadable.**

## Roadmap

### P0 — reliability foundation ✅

- full changed-topology validator
- atomic selected-map / multi-map transactions
- E1M1~E1M8 map-set build support
- selected-map authoring support
- real browser/WASM E2E
- automated episode experiment runner

### P1 — richer level authoring + autonomous QA

Planned next scope:

- **General THINGS authoring** — players starts, monsters, health, armor, ammo, weapons, keys, barrels and Doom thing flags instead of enemy-only convenience tools.
- **Richer semantic geometry** — stairs, lifts, doors, polygon rooms and safer sector split/merge primitives.
- **Navigation graph + autonomous agent** — build map connectivity/navigation data and let the agent verify reachability, traverse authored spaces, collect keys, operate doors and attempt exits without a manually supplied movement script.

This P1 layer is also the intended foundation for future **AI-generated multiplayer/deathmatch maps**, where spawn fairness, weapon/item distribution, line-of-sight and travel-distance evaluation can be added on top of the same map-set transaction/build/experiment pipeline.
