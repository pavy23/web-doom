# Web DOOM — Direct LinuxDOOM + AI Authoring MCP P1.4

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended into an AI-native DOOM authoring, deterministic validation, autonomous QA and conservative self-repair sandbox.

The `/direct/` runtime uses original LinuxDOOM gameplay/rendering/WAD code with repository-owned browser platform adapters. Chocolate Doom is used only for the pinned Vanilla/DMX-compatible OPL music subsystem, not as the game runtime.

## Play

- Direct build: https://pavy23.github.io/web-doom/direct/
- Earlier doomgeneric comparison build: https://pavy23.github.io/web-doom/
- Main development line after P1 consolidation: `main`

Current MCP version: **2.5.0-p1.4**

## What is complete

```text
P0    ✅ Reliable atomic episode authoring
P1.1  ✅ General THINGS authoring
P1.2  ✅ Semantic geometry authoring
P1.3  ✅ Navigation graph + autonomous QA
P1.4  ✅ Diagnose → repair → rebuild → replay closed loop
```

The full pipeline is now:

```text
natural-language authoring request
        ↓
P0 atomic transaction
        ↓
THINGS + semantic geometry edits
        ↓
deterministic topology / placement validation
        ↓
pinned ZDBSP rebuild
        ↓
navigation graph + progression analysis
        ↓
real LinuxDOOM / Chromium runtime
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

## P0 — reliable atomic authoring

P0 provides the reliability layer for selected-map and multi-map authoring:

- E1M1..E1M8 and selected map-set workspaces
- atomic begin/apply/validate/commit/rollback transactions
- duplicate/crossing/overlap/T-junction/manifold validation
- cross-map rollback on any failed edit
- pinned and hash-verified ZDBSP rebuilds
- candidate restore/finalize support
- real Chromium cold-boot regression
- automated exact-tic episode experiment runner with PNG + telemetry evidence

Core tools include:

- `doom_begin_episode_session`
- `doom_begin_transaction`
- `doom_apply_transaction_edits`
- `doom_validate_transaction`
- `doom_commit_transaction`
- `doom_rollback_transaction`
- `doom_build_episode`
- `doom_finalize_episode`
- `doom_run_episode_experiment`

## P1.1 — General THINGS authoring

P1.1 adds real classic 10-byte DOOM THINGS editing instead of enemy-only convenience calls.

Supported categories include:

- Player 1–4 starts and deathmatch starts
- monsters
- weapons and ammo
- health and armor
- blue/yellow/red keys
- powerups and barrels
- numeric DoomEd fallback

Operations:

- list
- add
- move
- update
- delete

Newly authored monsters, starts and barrels are also checked for invalid placement such as wall/void/solid-decoration overlap.

## P1.2 — Semantic geometry

P1.2 adds safer high-level geometry authoring on top of the raw Doom geometry IR.

Semantic operations include:

- convex polygon room extrusion
- staircases
- manual/keyed door rooms
- tagged lift rooms
- ordered sector-boundary inspection
- safe simple-sector split

Every edit still flows through P0 validation and pinned ZDBSP before runtime use.

## P1.3 — Navigation graph + autonomous QA

P1.3 turns authored geometry into a machine-readable gameplay graph.

Navigation edges are classified as:

- walk
- drop
- door
- lift
- blocked

The planner understands:

- Player 1 start
- blue/yellow/red keys
- keyed doors
- step-up and vertical-clearance constraints
- exit linedefs
- progressive reachability as keys are acquired

The browser agent uses deterministic exact-tic input and can rotate, move, use doors, recover from stalls and prove that a real LinuxDOOM player can reach an authored target sector.

Core tools:

- `doom_get_navigation_graph`
- `doom_find_navigation_path`
- `doom_analyze_exit_progression`
- `doom_run_navigation_trial`

## P1.4 — conservative auto-repair closed loop

P1.4 diagnoses navigation failures, proposes bounded repairs, applies them through P0 atomic transactions, rebuilds the WAD and verifies the result in real LinuxDOOM.

Core tools:

- `doom_p1_auto_repair_status`
- `doom_diagnose_navigation`
- `doom_plan_auto_repair`
- `doom_run_auto_repair_loop`

Supported repair classes include:

- missing/inaccessible key repair
- authored portal `ML_BLOCKING` repair
- authored sector step/clearance repair
- safe authored exit insertion

Safety rules:

- legacy Vanilla geometry is protected by default
- repair batches and iterations are bounded
- gameplay key repair can be disabled
- ambiguous disconnected geometry is not rewritten automatically
- unsupported cases return `manual_repair_required`
- runtime verification failure restores the pre-repair state by default

The final P1.4 runtime regression proves:

```text
real E1M1
→ author a new polygon room
→ deliberately block its authored portal
→ diagnose BLOCKED_PORTAL_FLAG
→ plan repair_clear_blocking
→ apply inside a P0 atomic transaction
→ validate
→ rebuild with ZDBSP
→ cold-boot LinuxDOOM
→ autonomous exact-tic navigation
→ enter the repaired authored sector
→ PASS
```

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
            P1.4 MCP composition
      p1_auto_repair_server.js
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
EpisodeWorkspace  Navigation     Browser agent
transactions      graph          exact-tic QA
validation        progression    replay
ZDBSP             diagnosis
      └──────────────┼──────────────┘
                     ▼
                  stdio MCP
                     │
          Grok / Claude / Codex / etc.
```

The public Pages game behaves normally. Local MCP WebSockets activate only when the game is opened through the local MCP proxy or by automated browser tests.

## Quick start

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
cd mcp
npm install
npx playwright install chromium
npm start
```

`npm start` launches:

```text
node p1_auto_repair_server.js
```

For interactive browser work open:

```text
http://127.0.0.1:3777/
```

Generic MCP host configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/p1_auto_repair_server.js"]
}
```

For Grok CLI:

```powershell
grok mcp add --scope project doom-p14 -- node D:\web-doom\mcp\p1_auto_repair_server.js
```

Use the P1.4 entry point for normal testing. `geometry_server.js` is a lower-level geometry layer and does not expose the complete P1.4 tool set.

## Useful test commands

Static regressions:

```bash
npm run test:p0
npm run test:p1
npm run test:p1:semantic
npm run test:p1:navigation
npm run test:p1:auto-repair
```

Runtime regressions:

```bash
node p0_browser_e2e.mjs
npm run test:experiment
node p1_runtime_selftest.mjs
npm run test:p1:semantic:runtime
npm run test:p1:navigation:runtime
npm run test:p1:auto-repair:runtime
```

The final P1.4 GitHub Actions gate runs on Node 24 and requires all of the above static and runtime layers to pass.

## Node builder

Structural authoring uses immutable artifacts from `seanmorris/zdbsp-wasm` commit:

```text
acc45bf6b2232a75bdbb0b6295822e72e13dfeec
```

The wrapper and WASM binary are cached under `mcp/.cache/zdbsp/` and checked against their exact Git blob SHA before execution.

The Vanilla-compatible node build uses:

```text
--zero-reject
--no-prune
--map=E#M#
```

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

## Current boundary

P1.4 is deliberately conservative. It can author and validate rich modifications to existing maps and can repair a bounded set of navigation/progression faults, but it does **not** yet generate a whole level from an empty map marker.

The governing rule remains:

> **AI proposes authoring and repair actions; deterministic validation, node building and real runtime QA decide whether the result is accepted.**

## Roadmap

### P0 — reliability foundation ✅

- full changed-topology validator
- atomic selected-map / multi-map transactions
- deterministic node rebuild
- browser/WASM regression and episode experiment runner

### P1.1 — General THINGS ✅

- starts, monsters, weapons, ammo, health, armor, keys, powerups and props
- real serialization and placement checks

### P1.2 — Semantic geometry ✅

- polygon rooms
- stairs
- doors
- lifts
- safe sector split

### P1.3 — Navigation + autonomous QA ✅

- sector/portal navigation graph
- keyed progression analysis
- autonomous exact-tic runtime traversal

### P1.4 — Auto-repair closed loop ✅

- navigation failure diagnosis
- conservative bounded repair
- atomic validation/rebuild
- LinuxDOOM replay verification and rollback

### P2.0 — Blank-map generation ⏭️

Next target: create a valid new `E1M1` / `MAP01` from no legacy map baseline, then feed it through the proven P0→P1.4 validation, navigation, repair and runtime-QA pipeline.

Later P2 work can add game-design evaluation and multiplayer/deathmatch generation on top of the same infrastructure.
