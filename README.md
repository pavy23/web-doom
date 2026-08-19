# Web DOOM — Direct LinuxDOOM + AI Authoring MCP P2.2

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended into an AI-native DOOM authoring, deterministic validation, autonomous QA, conservative self-repair, source-free level generation, game-design evaluation, **deathmatch generation and configurable local AI-player bots** sandbox.

The `/direct/` runtime uses original LinuxDOOM gameplay/rendering/WAD code with repository-owned browser platform adapters. Chocolate Doom is used only for the pinned Vanilla/DMX-compatible OPL music subsystem, not as the game runtime.

## Project state

- Public direct build: https://pavy23.github.io/web-doom/direct/
- Earlier doomgeneric comparison build: https://pavy23.github.io/web-doom/
- Stable P0→P1.4 baseline: `main`
- P2.0 source-free generation: `p2-blank-map-generation`
- P2.1 game-design evaluation: `p2-game-design-evaluator`
- P2.2 deathmatch + local bots: `p2-deathmatch-bots`

Current MCP version on the P2.2 branch: **2.8.0-p2.2**

> The public `/direct/` deployment is still the stable single-player runtime. P2.2's bot-capable LinuxDOOM/WASM is built branch-locally or in CI until the P2 line is later consolidated and published.

## Completed milestones

```text
P0    ✅ Reliable atomic episode authoring
P1.1  ✅ General THINGS authoring
P1.2  ✅ Semantic geometry authoring
P1.3  ✅ Navigation graph + autonomous QA
P1.4  ✅ Diagnose → repair → rebuild → replay closed loop
P2.0  ✅ Source-free blank-map generation
P2.1  ✅ Deterministic game-design evaluator
P2.2  ✅ Deathmatch generation + fairness + local AI players
P3.0  ⏭️ Online browser multiplayer transport
```

The current pipeline can begin from no legacy level at all:

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
- 8 independent navigation loops
- equal radial shotgun + shell access from every spawn
- central rocket launcher as a high-value contested pickup
- health / armor around center approaches
- shareware-safe `STARTAN3 / FLOOR4_8 / CEIL3_5` materials

The design principle is:

> **Basic survival access is symmetric; high-value control remains competitive.**

### P2.2 fairness metrics

The deterministic evaluator scores:

- spawn distance
- spawn→weapon access
- immediate route choice
- initial line-of-sight exposure
- high-value pickup access equity
- topology / loop quality

The accepted balanced seed scored:

```text
Overall              84.67 (B)
Spawn distance       78.78
Weapon access        99.82
Route choice        100.00
Initial exposure      6.25
High-value equity    99.95
Topology             100.00

Deathmatch starts        8
Independent loops        8
Nearest-weapon CV    0.001
High-value-item CV   0.000
```

The arena is intentionally visually open at this checkpoint, so `SPAWN_EXPOSURE_HIGH` is still reported rather than hidden.

An intentionally biased candidate — one clustered spawn plus a rocket launcher moved toward another spawn — fell to **48.2 (F)**. Restoring the balanced version produced a **+36.47** fairness delta.

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

The P2.2 platform mode deliberately remains one process / one network node:

```text
netgame = false
numnodes = 1
numplayers = 1..4
```

This keeps remote packet synchronization out of P2.2 while enabling true local multiplayer semantics. A narrow compatibility patch preserves the original per-player deathmatch respawn path instead of reloading the whole level when a local player dies.

### Bot difficulty

Built-in presets:

| Skill | Reaction tics | Aim tolerance | Behavior |
|---|---:|---:|---|
| Easy | 10 | 20° | slow reaction, low aggression/dodge |
| Normal | 5 | 11° | balanced baseline |
| Hard | 3 | 6° | fast, aggressive, stronger dodge |
| Nightmare | 1 | 2.5° | near-every-tic decisions and tight aim |

Difficulty also changes movement, turn gain, strafe, aggression, item bias and dodge behavior.

### Four-bot acceptance

A 700-exact-tic LinuxDOOM match ran four different policies simultaneously:

```text
Player 1 Easy       74 decisions /  3 attacks /  834 movement / 0 frags
Player 2 Normal    141 decisions / 23 attacks / 1524 movement / 0 frags
Player 3 Hard      234 decisions /  7 attacks / 4752 movement / 2 frags
Player 4 Nightmare 700 decisions / 13 attacks / 5314 movement / 1 frag
```

Real damage and real frags were observed under the original LinuxDOOM gameplay rules.

### Player 1 human + three bots

P2.2 also supports an interactive browser mode:

```text
Player 1  human keyboard / mouse
Player 2  configurable bot
Player 3  configurable bot
Player 4  configurable bot
```

CI verifies that the Player 1 autonomous-agent override remains inactive while browser keyboard input is sent, and that Players 2–4 independently receive live bot decisions.

Accepted short-run example:

```text
Player 2 Easy        14 bot decisions
Player 3 Hard        37 bot decisions
Player 4 Nightmare  110 bot decisions
Player 1 agent override: false
```

Live controls are also exposed in the browser console:

```js
DoomLocalBots.status()
DoomLocalBots.setSkill(1, 'hard')      // Player 2
DoomLocalBots.setSkill(2, 'nightmare') // Player 3
DoomLocalBots.stop()
DoomLocalBots.start()
```

## P2.2 MCP entry point

```text
mcp/p2_human_bot_server.js
```

`npm start` on the P2.2 branch launches this full server. Earlier milestones remain available through `start:p2.1`, `start:p2.0`, `start:p1.4`, and the lower-level scripts.

Important P2.2 tools:

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

All P0→P2.1 tools remain composed underneath the P2.2 entry point.

## Windows + Grok quick start for P2.2

The bot-capable runtime should be prepared once from the P2.2 branch. The provided PowerShell wrapper uses WSL because the pinned LinuxDOOM/Emscripten build is Linux-based.

```powershell
cd D:\web-doom
git switch p2-deathmatch-bots
git pull

.\direct-port\prepare_p22_runtime.ps1

cd mcp
npm install
npm start
```

The wrapper writes the local bot-capable runtime to:

```text
mcp/.cache/p22-runtime
```

and sets `DOOM_MCP_GAME_DIR` for the current PowerShell session.

Register the final MCP server in Grok:

```powershell
grok mcp add --scope project doom-p22 -- node D:\web-doom\mcp\p2_human_bot_server.js
```

A typical interactive flow is:

1. call `doom_create_deathmatch_arena` and export e.g. `arena.wad`;
2. inspect or iterate with the P2.2 fairness tools;
3. call `doom_prepare_human_bot_arena` with e.g. `easy`, `hard`, `nightmare`;
4. open the returned localhost URL;
5. click **CLICK TO START**;
6. play normally as Player 1 against the three AI player slots.

For automated map balancing, use `doom_run_local_bot_deathmatch` in `all_bots` mode.

## Earlier reliability layers

### P0 — atomic authoring

- selected-map and multi-map workspaces
- begin/apply/validate/commit/rollback transactions
- duplicate/crossing/overlap/T-junction/manifold validation
- pinned, hash-verified ZDBSP rebuild
- real Chromium regression and exact-tic episode experiments

### P1.1 — General THINGS

- Player starts / deathmatch starts
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
- P0→P1.4 reuse on newly generated maps

### P2.1 — Game-design evaluator

- deterministic reachability / progression / topology / combat / resource / pacing proxies
- balanced / combat / exploration profiles
- structured issues and before/after comparison

Reference P2.1 acceptance:

```text
Under-supported Cyberdemon candidate  70.3 (C), resources 12.25
Supported candidate                  83.5 (B), resources 100
Delta                                +13.2
```

## Test commands

P2-specific static tests:

```bash
npm run test:p2
npm run test:p2:game-design
npm run test:p2:deathmatch
```

P2 runtime tests:

```bash
npm run test:p2:seed-runtime
npm run test:p2:runtime
npm run test:p2:bots:runtime
npm run test:p2:human-bots:runtime
```

Stacked regression examples:

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

P2.2 proves the content and local simulation side of multiplayer:

- multiplayer maps can be generated from zero;
- fairness can be measured and compared;
- four real LinuxDOOM player slots can run in one browser;
- each AI player can have a different skill;
- a human can play Player 1 against three AI players.

The next milestone is **remote browser synchronization**, not another map-authoring layer.

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

After that: 4 remote players, bot-filled slots, reconnect/lobby support and richer online telemetry.

See:

- `mcp/P2_BLANK_MAP.md`
- `mcp/P2_GAME_DESIGN.md`
- `mcp/P2_DEATHMATCH.md`
- `mcp/P2_STATUS.md`
- `.github/P2_MULTIPLAYER_ROADMAP.md`

The governing rule remains:

> **AI proposes generation, authoring, evaluation and repair actions; deterministic validation, node building and real LinuxDOOM runtime evidence decide whether the result is accepted.**
