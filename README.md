# Web DOOM — Direct LinuxDOOM + AI Authoring MCP P2.0

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended into an AI-native DOOM authoring, deterministic validation, autonomous QA, conservative self-repair and now **source-free level generation** sandbox.

The `/direct/` runtime uses original LinuxDOOM gameplay/rendering/WAD code with repository-owned browser platform adapters. Chocolate Doom is used only for the pinned Vanilla/DMX-compatible OPL music subsystem, not as the game runtime.

## Play

- Direct build: https://pavy23.github.io/web-doom/direct/
- Earlier doomgeneric comparison build: https://pavy23.github.io/web-doom/
- Stable P0→P1.4 baseline: `main`
- P2.0 development branch: `p2-blank-map-generation`

Current MCP version on the P2.0 branch: **2.6.0-p2.0**

## What is complete

```text
P0    ✅ Reliable atomic episode authoring
P1.1  ✅ General THINGS authoring
P1.2  ✅ Semantic geometry authoring
P1.3  ✅ Navigation graph + autonomous QA
P1.4  ✅ Diagnose → repair → rebuild → replay closed loop
P2.0  ✅ Source-free blank-map generation
```

The full pipeline can now start without an existing Doom level:

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
real LinuxDOOM / Chromium
      ↓
autonomous exact-tic playtest
      ↓
P1.4 diagnosis + conservative repair when needed
      ↓
rebuild + cold boot + autonomous replay
      ↓
PASS / rollback / manual-repair-required
```

The AI does not write BSP nodes directly. Structural edits must pass deterministic validation and the pinned node-builder pipeline before LinuxDOOM loads them.

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

The P2 server composes P1.4, so the existing P0/P1 tool surface remains available too.

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

## P2.0 acceptance proof

The final source-free regression proves:

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
              P2.0 MCP server
          p2_blank_server.js
                     │
       ┌─────────────┼──────────────┐
       ▼             ▼              ▼
 Blank-map seed   P0/P1 stack    Browser agent
 + workspace      validation     exact-tic QA
                  navigation     replay
                  auto-repair
       └─────────────┼──────────────┘
                     ▼
                  stdio MCP
                     │
          Grok / Claude / Codex / etc.
```

## Quick start — P2.0

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout p2-blank-map-generation
cd mcp
npm install
npx playwright install chromium
npm start
```

`npm start` launches:

```text
node p2_blank_server.js
```

The previous complete P1.4 entry point remains available:

```bash
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
  "args": ["C:/absolute/path/to/web-doom/mcp/p2_blank_server.js"]
}
```

For Grok CLI:

```powershell
grok mcp add --scope project doom-p20 -- node D:\web-doom\mcp\p2_blank_server.js
```

## Useful test commands

P2-specific:

```bash
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

The P2 GitHub Actions gate runs on Node 24 and retains the complete P0→P1.4 static/runtime suite in addition to the P2 seed and full source-free regressions.

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

Online multiplayer is **feasible**, but it is intentionally separate from P2.0 map generation.

The browser platform currently uses a deliberately single-player `direct-port/i_net_web.c` shim: `netgame=false`, one player/node, and no real `I_NetCmd()` transport. The LinuxDOOM game/network layer above that platform boundary remains available.

Recommended sequence:

```text
P2.0  source-free maps                    ✅
P2.1  game-design evaluator               ⏭️
P2.2  deathmatch map generation/fairness
P3.0  browser online multiplayer transport
```

The first P3 prototype should use a **WebSocket relay** between two browser clients because it is easier to instrument, synchronize and reproduce than a peer-to-peer implementation. WebRTC DataChannel can be evaluated afterward.

A sensible first online acceptance target is: two browser clients load the same generated deathmatch PWAD, exchange LinuxDOOM tic packets through the relay, and remain synchronized for a bounded match interval.

## Current boundary

P2.0 can generate a valid source-free map, safely extend it, populate it with THINGS, diagnose navigation faults, repair bounded failures, rebuild it and prove traversal in real LinuxDOOM.

It does **not yet** take a high-level brief such as “make me a balanced 10-minute E1-style level” and autonomously optimize pacing, combat/resource economy and fun. That is the purpose of P2.1 and later P2 work.

The governing rule remains:

> **AI proposes generation, authoring and repair actions; deterministic validation, node building and real runtime QA decide whether the result is accepted.**

## Roadmap

### P0 — Reliability foundation ✅
### P1.1 — General THINGS ✅
### P1.2 — Semantic geometry ✅
### P1.3 — Navigation + autonomous QA ✅
### P1.4 — Auto-repair closed loop ✅
### P2.0 — Source-free blank-map generation ✅
### P2.1 — Game-design evaluator ⏭️
### P2.2 — Multiplayer / deathmatch map generator
### P3.0 — Online multiplayer transport

See `mcp/P2_BLANK_MAP.md`, `mcp/P2_STATUS.md` and `.github/P2_MULTIPLAYER_ROADMAP.md` for the current P2 design and acceptance details.
