# Web DOOM — Direct LinuxDOOM + AI Authoring MCP P2.2

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended into an AI-native DOOM authoring sandbox with deterministic validation, autonomous QA, conservative self-repair, source-free level generation, game-design evaluation, deathmatch generation, and configurable local AI-player bots.

The `/direct/` runtime uses original LinuxDOOM gameplay/rendering/WAD code with repository-owned browser platform adapters. Chocolate Doom is used only for the pinned Vanilla/DMX-compatible OPL music subsystem, not as the game runtime.

## Project state

**`main` now contains the complete P0 → P2.2 stack.**

- Public direct build: https://pavy23.github.io/web-doom/direct/
- Earlier doomgeneric comparison build: https://pavy23.github.io/web-doom/
- Current source branch: `main`
- Current MCP version: **2.8.0-p2.2**
- Next milestone: **P3.0 online browser multiplayer transport**

> The public `/direct/` deployment is now the validated P2.2 bot-capable build. Its launcher offers **PLAY CLASSIC DOOM** and **PLAY AI DEATHMATCH**. AI Deathmatch loads the bundled generated `p22-demo.wad` and starts Player 1 as the human against Easy / Normal / Hard local AI players.

### Public launcher

- **PLAY CLASSIC DOOM** — original shareware campaign with one local player.
- **PLAY AI DEATHMATCH** — deterministic P2.2 demo arena with Player 1 human + three real LinuxDOOM AI player slots (Easy / Normal / Hard).

The bundled public arena is generated and validated during CI before `/direct/` is published:

```text
p22-demo.wad
E1M1
fairness 84.67 / B
8 deathmatch starts
8 loops
nearest-weapon cost CV 0.001
high-value-item cost CV 0.000
```

## Completed milestones

| Milestone | Status | Capability |
|---|---|---|
| P0 | ✅ | Reliable atomic episode authoring |
| P1.1 | ✅ | General THINGS authoring |
| P1.2 | ✅ | Semantic geometry authoring |
| P1.3 | ✅ | Navigation graph + autonomous QA |
| P1.4 | ✅ | Diagnose → repair → rebuild → replay closed loop |
| P2.0 | ✅ | Source-free blank-map generation |
| P2.1 | ✅ | Deterministic game-design evaluator |
| P2.2 | ✅ | Deathmatch generation + fairness + local AI players |
| P3.0 | ⏭️ | Online browser multiplayer transport |

The full pipeline can begin from **no legacy level at all**:

```text
high-level authoring request
        ↓
source-free map / deathmatch generation
        ↓
P0 atomic transaction
        ↓
P1.1 THINGS + P1.2 semantic geometry
        ↓
deterministic topology / placement validation
        ↓
pinned ZDBSP rebuild
        ↓
P1.3 navigation / progression analysis
        ↓
P2.1 single-player design-proxy evaluation
or
P2.2 deathmatch fairness evaluation
        ↓
real LinuxDOOM / Chromium runtime
        ↓
autonomous playtest / local AI-player match
        ↓
P1.4 repair or new authoring iteration
        ↓
rebuild + before/after comparison
```

The AI does not write BSP nodes directly. Structural edits must pass deterministic validation and the pinned node-builder pipeline before LinuxDOOM loads them.

## P2.2 — source-free deathmatch generation

The accepted default deathmatch seed uses an **octagonal ring + contested center** topology:

- 8 ring sectors + 1 center sector
- 8 DoomEd 11 deathmatch starts
- real Player 1–4 starts
- multiple independent navigation loops
- equal radial shotgun + shell access from every spawn
- central rocket launcher as a high-value contested pickup
- health / armor around center approaches
- shareware-safe `STARTAN3 / FLOOR4_8 / CEIL3_5` materials

Design principle:

> **Basic survival access is symmetric; high-value control remains competitive.**

### Deterministic fairness evaluation

P2.2 scores multiplayer maps using repeatable proxies for:

- pairwise spawn distance
- spawn → weapon access
- immediate route choice
- initial line-of-sight exposure
- high-value pickup access equity
- topology / loop quality

The accepted balanced seed scores **84.67 / B**. An intentionally biased comparison candidate falls to **48.2 / F**, allowing AI-driven before/after balancing without relying on subjective labels alone.

## Real local AI players

P2.2 bots use the original LinuxDOOM **`players[0..3]` player slots**. They are not monsters disguised as players.

```text
LinuxDOOM G_Ticker
       │
       ├─ Player 1 ticcmd
       ├─ Player 2 ticcmd
       ├─ Player 3 ticcmd
       └─ Player 4 ticcmd
             ▲
             │
     doom_multi_agent.c
             ▲
             │
 deterministic bot policy
```

P2.2 deliberately keeps this as one browser process / one network node:

```text
netgame = false
numnodes = 1
numplayers = 1..4
```

That isolates local multiplayer/gameplay semantics from remote network synchronization, which is reserved for P3.0.

### Supported local modes

- **1 human + 3 AI bots**
- **4 AI bots** for repeatable automated balance trials
- per-bot difficulty selection
- live bot difficulty changes from the browser console

### Bot difficulty presets

| Skill | Reaction tics | Aim tolerance | Character |
|---|---:|---:|---|
| Easy | 10 | 20° | slow reaction, lower aggression/dodge |
| Normal | 5 | 11° | balanced baseline |
| Hard | 3 | 6° | fast, aggressive, stronger dodge |
| Nightmare | 1 | 2.5° | near-every-tic decisions and tight aim |

Difficulty also changes movement, turn gain, strafe, aggression, item bias, and dodge behavior.

### Human + three bots

Interactive mode keeps Player 1 on the normal browser input path while Players 2–4 receive independent AI ticcmd streams:

```text
Player 1  human keyboard / mouse
Player 2  configurable bot
Player 3  configurable bot
Player 4  configurable bot
```

CI verifies that the Player 1 bot override remains inactive while Players 2–4 receive live bot decisions. Separate four-bot runtime acceptance also confirms real movement, combat, damage, deathmatch respawn, and frags under the original LinuxDOOM gameplay rules.

Live controls:

```js
DoomLocalBots.status()
DoomLocalBots.setSkill(1, 'hard')      // Player 2
DoomLocalBots.setSkill(2, 'nightmare') // Player 3
DoomLocalBots.stop()
DoomLocalBots.start()
```

## MCP entry point

The consolidated main entry point is:

```text
mcp/p2_human_bot_server.js
```

From `mcp/`:

```bash
npm start
```

Earlier milestones remain individually launchable:

```text
npm run start:p2.2-core
npm run start:p2.1
npm run start:p2.0
npm run start:p1.4
npm run start:p1.3
npm run start:p1.2
npm run start:p0
```

Important P2.2 tools include:

- `doom_p2_deathmatch_status`
- `doom_get_deathmatch_policy`
- `doom_get_bot_skill_profiles`
- `doom_resolve_bot_skill`
- `doom_create_deathmatch_arena`
- `doom_get_deathmatch_session`
- `doom_begin_deathmatch_transaction`
- `doom_apply_deathmatch_edits`
- `doom_validate_deathmatch_transaction`
- `doom_commit_deathmatch_transaction`
- `doom_rollback_deathmatch_transaction`
- `doom_build_deathmatch_level`
- `doom_evaluate_deathmatch_fairness`
- `doom_compare_deathmatch_fairness`
- `doom_run_local_bot_deathmatch`
- `doom_prepare_human_bot_arena`

All P0 → P2.1 tools are composed underneath the P2.2 server.

## Windows + WSL quick start

The P2.2 bot-capable runtime is built with the provided PowerShell wrapper. WSL is used because the pinned LinuxDOOM/Emscripten build pipeline is Linux-based.

```powershell
cd D:\web-doom

git switch main
git pull

.\direct-port\prepare_p22_runtime.ps1

cd mcp
npm install
npm start
```

The wrapper writes the bot-capable runtime to:

```text
mcp/.cache/p22-runtime
```

and sets `DOOM_MCP_GAME_DIR` for the current PowerShell session.

### Grok MCP registration example

```powershell
grok mcp add --scope project doom-p22 -- node D:\web-doom\mcp\p2_human_bot_server.js
```

Typical interactive flow:

1. call `doom_create_deathmatch_arena` and export a WAD;
2. inspect or iterate with the fairness tools;
3. call `doom_prepare_human_bot_arena` with three bot skills, for example `easy`, `hard`, `nightmare`;
4. open the returned localhost URL;
5. click **CLICK TO START**;
6. play normally as Player 1 against the three AI player slots.

For automated balancing, use `doom_run_local_bot_deathmatch` in `all_bots` mode.

## Reliability layers

### P0 — atomic authoring

- selected-map and multi-map workspaces
- begin/apply/validate/commit/rollback transactions
- duplicate/crossing/overlap/T-junction/manifold validation
- pinned, hash-verified ZDBSP rebuild
- real Chromium regression and exact-tic episode experiments

### P1.1 — General THINGS

- player starts / deathmatch starts
- monsters
- weapons / ammo
- health / armor
- keys / powerups / barrels
- persistent add/move/update/delete with placement checks

### P1.2 — Semantic geometry

- polygon-room extrusion
- stairs
- keyed/manual doors
- lifts
- sector boundary inspection
- safe simple-sector split

### P1.3 — Navigation + autonomous QA

- sector/portal navigation graph
- walk/drop/door/lift/blocked edges
- key and exit progression
- deterministic exact-tic browser traversal

### P1.4 — Conservative auto-repair

- navigation failure diagnosis
- bounded authored-geometry repair
- atomic validation / rebuild
- LinuxDOOM replay verification
- rollback or manual-repair-required fallback

### P2.0 — Source-free maps

- canonical map marker + classic map lumps from zero
- runtime-safe generated seed
- generated geometry treated as AI-authored
- P0 → P1.4 reuse on newly generated maps

### P2.1 — Game-design evaluator

- deterministic reachability / progression / topology / combat / resource / pacing proxies
- `balanced`, `combat`, `exploration` profiles
- structured issue codes
- exact-policy before/after comparison

Reference acceptance:

```text
Under-supported Cyberdemon candidate  70.3 (C), resources 12.25
Supported candidate                  83.5 (B), resources 100
Delta                                +13.2
```

## Test commands

Run from `mcp/`.

Static / deterministic tests:

```bash
npm run test:p0
npm run test:p1
npm run test:p1:semantic
npm run test:p1:navigation
npm run test:p1:auto-repair
npm run test:p2
npm run test:p2:game-design
npm run test:p2:deathmatch
```

Runtime / Chromium tests:

```bash
npm run test:experiment
npm run test:p1:semantic:runtime
npm run test:p1:navigation:runtime
npm run test:p1:auto-repair:runtime
npm run test:p2:seed-runtime
npm run test:p2:runtime
npm run test:p2:bots:runtime
npm run test:p2:human-bots:runtime
```

P2.2 acceptance retains the P0 → P2.1 regression chain and adds both four-bot and human-plus-three-bot real LinuxDOOM browser tests.

The public `/direct/` publication adds one more browser gate: `mcp/p22_public_direct_selftest.mjs` verifies both launcher paths on the freshly compiled static candidate before any main publish commit is allowed.

## Runtime / build baseline

Pinned LinuxDOOM baseline:

```text
a77dfb96cb91780ca334d0d4cfd86957558007e0
```

Pinned ZDBSP WASM source revision:

```text
acc45bf6b2232a75bdbb0b6295822e72e13dfeec
```

Pinned Chocolate Doom OPL source revision:

```text
410d96855b5df5410ff591a90efeafa889119224
```

Supported public shareware IWAD:

- size: 4,196,020 bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

## P3.0 — online multiplayer next

P2.2 now proves the content and local simulation side of multiplayer:

- multiplayer maps can be generated from zero;
- fairness can be measured and compared;
- four real LinuxDOOM player slots can run in one browser;
- each AI player can have a different skill;
- a human can play Player 1 against three AI players;
- the public `/direct/` build exposes the validated Classic / AI Deathmatch split.

The next milestone is **remote browser synchronization**.

Recommended first P3 target:

```text
Browser A ─┐
           ├─ WebSocket relay
Browser B ─┘

same PWAD hash
same match seed
bounded 2-player match
zero deterministic tic drift
```

After that: four remote players, bot-filled empty slots, lobby/reconnect support, and richer multiplayer telemetry.

## Reference docs

- `mcp/P2_BLANK_MAP.md`
- `mcp/P2_GAME_DESIGN.md`
- `mcp/P2_DEATHMATCH.md`
- `mcp/P2.2_BOTS.md`
- `mcp/P2_STATUS.md`
- `.github/P2_MULTIPLAYER_ROADMAP.md`

The governing rule remains:

> **AI proposes generation, authoring, evaluation, and repair actions; deterministic validation, node building, and real LinuxDOOM runtime evidence decide whether the result is accepted.**
