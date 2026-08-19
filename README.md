# Web DOOM — Direct LinuxDOOM + AI Authoring MCP P2.1

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended into an AI-native DOOM authoring, deterministic validation, autonomous QA, conservative self-repair, **source-free level generation and deterministic game-design evaluation** sandbox.

The `/direct/` runtime uses original LinuxDOOM gameplay/rendering/WAD code with repository-owned browser platform adapters. Chocolate Doom is used only for the pinned Vanilla/DMX-compatible OPL music subsystem, not as the game runtime.

## Play

- Direct build: https://pavy23.github.io/web-doom/direct/
- Earlier doomgeneric comparison build: https://pavy23.github.io/web-doom/
- Stable P0→P1.4 baseline: `main`
- P2.0 source-free generation: `p2-blank-map-generation`
- P2.1 game-design evaluation: `p2-game-design-evaluator`

Current MCP version on the P2.1 branch: **2.7.0-p2.1**

## What is complete

```text
P0    ✅ Reliable atomic episode authoring
P1.1  ✅ General THINGS authoring
P1.2  ✅ Semantic geometry authoring
P1.3  ✅ Navigation graph + autonomous QA
P1.4  ✅ Diagnose → repair → rebuild → replay closed loop
P2.0  ✅ Source-free blank-map generation
P2.1  ✅ Deterministic game-design evaluator
```

The pipeline can now generate, validate, repair, run and compare level-design iterations:

```text
no legacy map
      ↓
canonical E#M# / MAP## marker + classic map lumps
      ↓
runtime-safe generated seed
      ↓
P0 atomic transaction
      ↓
P1.1 THINGS + P1.2 semantic geometry
      ↓
deterministic topology / placement validation
      ↓
pinned ZDBSP rebuild
      ↓
P1.3 navigation graph + progression analysis
      ↓
P2.1 deterministic design-proxy evaluation
      ↓
real LinuxDOOM / Chromium autonomous QA
      ↓
P1.4 diagnosis + conservative repair when needed
      ↓
rebuild + replay + before/after comparison
      ↓
PASS / rollback / manual-repair-required / iterate
```

The AI does not write BSP nodes directly. Structural edits must pass deterministic validation and the pinned node-builder pipeline before LinuxDOOM loads them. P2.1 scores are iteration proxies, not objective measurements of fun.

## P2.0 — source-free blank-map generation

P2.0 removes the previous requirement that the source WAD already contain the map being authored.

A new map begins with the canonical sequence:

```text
<MAP MARKER>
THINGS
LINEDEFS
SIDEDEFS
VERTEXES
SEGS
SSECTORS
NODES
SECTORS
REJECT
BLOCKMAP
```

The geometry and THINGS are generated directly. `SEGS`, `SSECTORS`, `NODES`, `REJECT` and `BLOCKMAP` start as derived data and are rebuilt by pinned ZDBSP.

### Runtime-safe generated seed

The default seed is deliberately small but uses **two connected sectors**, not one:

- rectangular footprint split into left/right sectors
- six outer one-sided walls
- one two-sided internal portal
- Player 1 start in sector 0
- optional S1 exit wall (`special 11`)
- default wall: `STARTAN3`
- default floor: `FLOOR4_8`
- default ceiling: `CEIL3_5`
- default vertical clearance: 128 map units

Those material defaults are verified against the supported shareware E1M1 runtime baseline.

The two-sector seed is intentional. A single convex sector can cause ZDBSP to emit a zero-byte `NODES` lump; the generated two-sector seed produces a real Vanilla BSP node and has been verified in LinuxDOOM.

All seed primitives are marked **AI-authored** by setting the generated workspace's legacy boundary to zero. This means P1.4 can repair generated geometry with legacy repair still disabled.

### P2.0 MCP tools

- `doom_p2_blank_map_status`
- `doom_create_blank_map_session`
- `doom_get_blank_map_session`
- `doom_get_blank_map`
- `doom_begin_blank_transaction`
- `doom_apply_blank_edits`
- `doom_validate_blank_transaction`
- `doom_commit_blank_transaction`
- `doom_rollback_blank_transaction`
- `doom_validate_blank_map`
- `doom_build_blank_level`
- `doom_diagnose_blank_navigation`
- `doom_run_blank_auto_repair`
- `doom_run_blank_navigation_trial`

## P2.1 — deterministic game-design evaluator

P2.1 adds repeatable design-analysis on top of **built/exported PWAD candidates**. Invalid draft geometry is not given a game-design score.

Every evaluation returns six 0–100 components:

- `reachability`
- `progression`
- `topology`
- `combat`
- `resources`
- `pacing`

Three built-in design profiles change weights and heuristic target ranges without changing the underlying measurements:

- `balanced`
- `combat`
- `exploration`

The evaluator also filters THINGS by `easy`, `medium` or `hard` skill flags.

Measured proxies include:

- reachable-sector ratio
- key-aware exit progression and main-path depth
- loops, branch sectors, dead ends and average graph degree
- normalized monster threat density/distribution
- threat concentration and path volatility
- normalized ammo/weapon/health/armor/powerup support
- early weapon access
- start-room pressure
- early/late threat pacing

Structured findings include `EXIT_UNREACHABLE`, `TOPOLOGY_TOO_LINEAR`, `RESOURCE_STARVATION`, `NO_EARLY_WEAPON`, `THREAT_OVERCONCENTRATED`, `START_ROOM_OVERPRESSURED` and related issue codes. Findings include suggested follow-up actions, but P2.1 does not silently mutate the map.

### P2.1 MCP tools

- `doom_p2_game_design_status`
- `doom_get_game_design_policy`
- `doom_evaluate_game_design`
- `doom_compare_game_design`

The P2.1 server composes P2.0, which composes P1.4, so the complete P0→P2.0 tool surface remains available from the same MCP process.

### P2.1 acceptance proof

The deterministic regression deliberately builds a valid two-sector E1M1 with a Cyberdemon and no authored combat support.

Under the same `balanced / medium` policy:

```text
before
  overall: 70.3 (C)
  resources: 12.25
  issues: THREAT_OVERCONCENTRATED,
          RESOURCE_STARVATION,
          NO_EARLY_WEAPON,
          MAIN_PATH_TOO_SHORT

add shotgun + ammo + health + armor
rebuild

after
  overall: 83.5 (B)
  resources: 100
  delta: +13.2
  resolved: RESOURCE_STARVATION,
            NO_EARLY_WEAPON
```

Repeated evaluation of the same candidate must produce the same report. The same final map is also evaluated under combat and exploration profiles to prove that policy weighting can represent different design briefs.

This result should be interpreted as **the intended proxy metrics improved**, not as proof that the map became objectively more fun. Runtime QA and future combat/playtesting agents remain separate evidence layers.

## P0 — reliable atomic authoring

P0 provides the reliability layer beneath every later phase:

- selected-map and multi-map workspaces
- atomic begin/apply/validate/commit/rollback transactions
- duplicate/crossing/overlap/T-junction/manifold validation
- cross-map rollback on failed edits
- pinned and hash-verified ZDBSP rebuilds
- candidate restore/finalize support
- real Chromium cold-boot regression
- exact-tic episode experiment runner with PNG + telemetry evidence

## P1.1 — General THINGS authoring

P1.1 edits real classic 10-byte DOOM THINGS:

- Player 1–4 starts and deathmatch starts
- monsters
- weapons and ammo
- health and armor
- blue/yellow/red keys
- powerups and barrels
- numeric DoomEd fallback

Persistent add/move/update/delete operations participate in P0 atomic transactions and authored actor placement checks.

## P1.2 — Semantic geometry

High-level authoring operations include:

- convex polygon room extrusion
- staircases
- manual/keyed door rooms
- tagged lift rooms
- ordered sector-boundary inspection
- safe simple-sector split

Generated P2 maps use this exact same semantic layer rather than a separate level generator.

## P1.3 — Navigation graph + autonomous QA

P1.3 derives gameplay connectivity directly from Doom geometry and classifies portals as walk/drop/door/lift/blocked.

The planner understands Player 1 start, key acquisition, keyed doors, step/clearance limits and exits. The browser agent then verifies the planned path in real LinuxDOOM using deterministic exact-tic input.

Core tools:

- `doom_get_navigation_graph`
- `doom_find_navigation_path`
- `doom_analyze_exit_progression`
- `doom_run_navigation_trial`

## P1.4 — conservative auto-repair

P1.4 can diagnose and conservatively repair bounded gameplay failures such as:

- missing/inaccessible keys
- authored portal `ML_BLOCKING`
- authored sector step/clearance defects
- safe authored exit insertion

Repairs run through P0 atomic validation, rebuild with ZDBSP and can be verified by autonomous LinuxDOOM replay. Legacy Vanilla geometry remains protected unless explicitly enabled.

## P2.0 runtime acceptance proof

The source-free regression proves:

```text
no legacy E1M1 source
→ generate runtime-safe two-sector E1M1
→ validate seed
→ P1.2 adds a new polygon room
→ deliberately block the authored portal
→ P1.4 diagnoses BLOCKED_PORTAL_FLAG
→ plan + apply repair_clear_blocking
→ atomic validation + commit
→ pinned ZDBSP rebuild
→ LinuxDOOM standard runtime warp
→ autonomous exact-tic navigation
→ enter generated target sector
→ PASS
```

CI additionally validates SEG/SSECTOR/NODE/BLOCKMAP references and separately proves the untouched generated seed itself boots in LinuxDOOM.

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
              P2.1 MCP server
       p2_game_design_server.js
                     │
       ┌─────────────┼──────────────┐
       ▼             ▼              ▼
 P2.0 generation   Evaluator     Browser agent
 P0/P1 stack       deterministic exact-tic QA
 validation        proxies       replay
 navigation        comparison
 auto-repair
       └─────────────┼──────────────┘
                     ▼
                  stdio MCP
                     │
          Grok / Claude / Codex / etc.
```

## Quick start — P2.1

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout p2-game-design-evaluator
cd mcp
npm install
npx playwright install chromium
npm start
```

`npm start` launches:

```text
node p2_game_design_server.js
```

Previous complete entry points remain available:

```bash
npm run start:p2.0
npm run start:p1.4
```

For interactive browser work open:

```text
http://127.0.0.1:3777/
```

Generic MCP host configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/p2_game_design_server.js"]
}
```

For Grok CLI:

```powershell
grok mcp add --scope project doom-p21 -- node D:\web-doom\mcp\p2_game_design_server.js
```

## Useful test commands

P2.1 / P2.0:

```bash
npm run test:p2:game-design
npm run test:p2
npm run test:p2:seed-runtime
npm run test:p2:runtime
```

Stacked regressions:

```bash
npm run test:p0
npm run test:p1
npm run test:p1:semantic
npm run test:p1:navigation
npm run test:p1:auto-repair
npm run test:experiment
npm run test:p1:semantic:runtime
npm run test:p1:navigation:runtime
npm run test:p1:auto-repair:runtime
```

The P2.1 GitHub Actions gate runs on Node 24 and retains the complete P0→P2.0 static/runtime suite in addition to the deterministic evaluator regression.

## Node builder

Structural authoring uses immutable artifacts from `seanmorris/zdbsp-wasm` commit:

```text
acc45bf6b2232a75bdbb0b6295822e72e13dfeec
```

The wrapper and WASM binary are cached under `mcp/.cache/zdbsp/` and checked against their exact Git blob SHA before execution.

## Runtime baseline

LinuxDOOM baseline:

```text
a77dfb96cb91780ca334d0d4cfd86957558007e0
```

Pinned Chocolate Doom OPL source revision:

```text
410d96855b5df5410ff591a90efeafa889119224
```

Public shareware IWAD:

- size: 4,196,020 bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

## Online multiplayer direction

Online multiplayer is **feasible**, but it remains intentionally separate from the P2.1 single-player evaluator.

The browser platform currently uses a deliberately single-player `direct-port/i_net_web.c` shim: `netgame=false`, one player/node, and no real `I_NetCmd()` transport. The LinuxDOOM game/network layer above that platform boundary remains available.

Recommended sequence:

```text
P2.0  source-free maps                    ✅
P2.1  game-design evaluator               ✅
P2.2  deathmatch map generation/fairness  ⏭️
P3.0  browser online multiplayer transport
```

P2.2 can reuse the P2.1 evaluator framework for spawn-distance fairness, spawn-to-weapon path cost, line-of-sight exposure, alternate routes, chokepoints and item distribution.

The first P3 prototype should use a **WebSocket relay** between two browser clients because it is easier to instrument, synchronize and reproduce than a peer-to-peer implementation. WebRTC DataChannel can be evaluated afterward.

A sensible first online acceptance target is: two browser clients load the same generated deathmatch PWAD, exchange LinuxDOOM tic packets through the relay, and remain synchronized for a bounded match interval.

## Current boundary

P2.1 can generate a valid source-free map, safely edit/populate it, diagnose navigation faults, repair bounded failures, build and run it in LinuxDOOM, then produce repeatable design-proxy scores and compare subsequent built candidates.

It does **not yet** autonomously search many alternative designs until a brief is optimized, nor does it simulate real combat quality. P2.2 adds multiplayer/deathmatch-specific generation and fairness analysis; later work can add richer combat agents and bounded design-search loops.

The governing rule remains:

> **AI proposes generation, authoring, repair and design changes; deterministic validation, node building, explicit evaluation policy and real runtime QA decide what evidence is accepted.**

## Roadmap

### P0 — Reliability foundation ✅
### P1.1 — General THINGS ✅
### P1.2 — Semantic geometry ✅
### P1.3 — Navigation + autonomous QA ✅
### P1.4 — Auto-repair closed loop ✅
### P2.0 — Source-free blank-map generation ✅
### P2.1 — Deterministic game-design evaluator ✅
### P2.2 — Multiplayer / deathmatch map generator + fairness evaluator ⏭️
### P3.0 — Online multiplayer transport

See `mcp/P2_BLANK_MAP.md`, `mcp/P2_GAME_DESIGN.md`, `mcp/P2_STATUS.md` and `.github/P2_MULTIPLAYER_ROADMAP.md` for current design and acceptance details.
