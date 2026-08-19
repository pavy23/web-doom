# P2.2 — Deathmatch Generation, Fairness and Local Bots

P2.2 extends the source-free P2 pipeline from single-player design into deterministic four-player deathmatch generation, fairness analysis and true local LinuxDOOM player bots.

## Scope

```text
source-free deathmatch brief
        ↓
balanced arena generator
        ↓
8 deathmatch starts + 4 player starts
        ↓
P0 topology / THINGS validation
        ↓
pinned ZDBSP
        ↓
P2.2 fairness evaluator
        ↓
iterate through atomic P0/P1 transactions
        ↓
bot-capable LinuxDOOM/WASM
        ↓
4-bot automated trial
or
Player 1 human + Players 2–4 bots
```

Remote browser-to-browser networking is intentionally **not** part of P2.2. All P2.2 bots share one LinuxDOOM process and one local network node. P3.0 will add a real browser transport.

## Generated arena

The accepted default arena is an octagonal ring surrounding a contested center:

- 8 ring sectors + 1 center sector
- 8 valid DoomEd 11 deathmatch starts
- Player 1–4 starts
- multiple loop routes through ring and center
- equal radial shotgun + shell access for all deathmatch starts
- central rocket launcher as a contested high-value pickup
- health / armor support around the center approaches
- `STARTAN3`, `FLOOR4_8`, `CEIL3_5` shareware-safe materials

The design rule is intentional: **basic survival access is symmetric; high-value control remains competitive.**

## Deterministic deathmatch fairness

P2.2 scores six components from 0–100:

- spawn distance
- nearest weapon access
- immediate route choice
- initial line-of-sight exposure
- high-value pickup equity
- topology / loop quality

Reported metrics include:

- pairwise spawn path cost and coefficient of variation
- nearest weapon access cost variation
- high-value weapon access variation
- immediate spawn-to-spawn line-of-sight exposure
- route choices from spawn sectors
- independent navigation loop count

Structured issues include:

- `DM_STARTS_INSUFFICIENT`
- `DM_WEAPONS_MISSING`
- `SPAWN_TOO_CLOSE`
- `WEAPON_ACCESS_IMBALANCE`
- `HIGH_VALUE_ITEM_BIAS`
- `SPAWN_ROUTE_STARVATION`
- `SPAWN_EXPOSURE_HIGH`
- `SPAWN_ISOLATION_HIGH`
- `DM_LOOP_COUNT_LOW`

As with P2.1, this score is a deterministic iteration proxy rather than an objective measurement of fun or competitive quality.

## Static acceptance result

The accepted balanced seed scored:

```text
Overall              84.67 (B)
Spawn distance       78.78
Weapon access        99.82
Route choice        100.00
Initial exposure      6.25
High-value equity    99.95
Topology             100.00
```

Key measured values:

```text
Sectors                         9
Passable directed edges        32
Independent loops               8
Deathmatch starts               8
Weapon pickups                  9
Nearest-weapon cost CV       0.001
High-value cost CV           0.000
Average spawn route choices     3
```

The current seed intentionally remains visually open, so `SPAWN_EXPOSURE_HIGH` is still reported. This is a useful P2.3/P2.2-iteration target rather than a hidden evaluator exception.

A deliberately unfair candidate was created by clustering one spawn and moving the central rocket toward another spawn. It fell to **48.2 (F)** and introduced:

- `SPAWN_TOO_CLOSE`
- `WEAPON_ACCESS_IMBALANCE`
- `HIGH_VALUE_ITEM_BIAS`
- `SPAWN_EXPOSURE_HIGH`

Restoring the balanced design produced a **+36.47** overall fairness delta.

## Bot architecture

P2.2 bots are not monster actors pretending to be players. They use the original LinuxDOOM `players[0..3]` slots.

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

The platform shim keeps:

```text
netgame = false
numnodes = 1
numplayers = 1..4
```

This avoids introducing remote packet synchronization in P2.2 while still enabling true local multiplayer player slots. `D_CheckNetGame()` marks the requested player slots active from `doomcom->numplayers`.

A narrow compatibility patch preserves native deathmatch respawn behavior: local multiplayer deaths use the original `G_DeathMatchSpawnPlayer()` path instead of reloading the entire level even though remote `netgame` remains false.

## Bot perception and control

The C/WASM bridge exposes per-player state and perception:

- position and angle
- health / armor
- ready weapon
- frags
- current input budget
- nearest live opponent
- engine `P_CheckSight` visibility
- target distance
- desired angle / angle delta

Each player can receive an independent bounded ticcmd through:

```text
doomctl_queue_player_input(player, forward, strafe, turn, attack, use, tics)
```

Existing P1 console-player autonomous APIs remain compatible.

## Bot difficulty

Built-in deterministic presets:

| Skill | Reaction tics | Aim tolerance | Character |
|---|---:|---:|---|
| easy | 10 | 20° | slower, less aggressive, weak dodge |
| normal | 5 | 11° | balanced baseline |
| hard | 3 | 6° | faster, aggressive, stronger dodge |
| nightmare | 1 | 2.5° | near-every-tic decisions, tight aim, high aggression |

Difficulty also changes turn gain, movement, strafe, aggression, item bias and dodge behavior. The evaluator helper supports custom overrides, while MCP exposes the named presets directly.

## Four-bot runtime acceptance

The final CI runs four different policies simultaneously for 700 exact tics:

```text
Player 1  easy
Player 2  normal
Player 3  hard
Player 4  nightmare
```

Observed accepted run:

```text
Decisions:       P1  74 / P2 141 / P3 234 / P4 700
Attacks:         P1   3 / P2  23 / P3   7 / P4  13
Travel distance: P1 834 / P2 1524 / P3 4752 / P4 5314
Damage observed: true
Frag observed:   true
Final frags:     P1 0 / P2 0 / P3 2 / P4 1
```

This proves the difficulty profiles produce materially different decision cadences while all four real player slots move, attack and interact under LinuxDOOM gameplay rules.

## Human + three bots

P2.2 also supports a real-time interactive browser mode:

```text
Player 1  human keyboard / mouse
Player 2  configurable bot
Player 3  configurable bot
Player 4  configurable bot
```

The live scheduler never queues the P1 autonomous agent API for Player 1. CI verifies that Player 1's agent-input override stays inactive while a real browser keyboard event is sent and Players 2–4 receive bot decisions.

Accepted browser test example:

```text
Player 2  easy
Player 3  hard
Player 4  nightmare
Bot decisions after short live run: 14 / 37 / 110
Player 1 agent override active: false
```

Runtime controls are exposed in the browser console:

```js
DoomLocalBots.status()
DoomLocalBots.setSkill(1, 'hard')
DoomLocalBots.setSkill(2, 'nightmare')
DoomLocalBots.stop()
DoomLocalBots.start()
```

Player indices are zero-based, so `setSkill(1, ...)` changes Player 2.

## MCP entry point

Final P2.2 entry point:

```text
mcp/p2_human_bot_server.js
```

`npm start` launches it.

Core P2.2 tools:

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

All P2.1/P2.0/P1/P0 tools remain composed underneath this server.

## Windows / Grok local use

The public `/direct/` runtime is not assumed to contain the P2.2 bot additions yet. Build the branch-local bot-capable runtime once through WSL:

```powershell
cd D:\web-doom
git switch p2-deathmatch-bots
git pull

.\direct-port\prepare_p22_runtime.ps1

cd mcp
npm install
npm start
```

The PowerShell wrapper builds the pinned LinuxDOOM/Emscripten runtime in WSL and sets `DOOM_MCP_GAME_DIR` for the current PowerShell session to:

```text
mcp/.cache/p22-runtime
```

Point Grok at:

```powershell
grok mcp add --scope project doom-p22 -- node D:\web-doom\mcp\p2_human_bot_server.js
```

Then a typical flow is:

1. `doom_create_deathmatch_arena` → export `arena.wad`
2. inspect / iterate with P2.2 fairness tools
3. call `doom_prepare_human_bot_arena` with e.g. `easy`, `hard`, `nightmare`
4. open the returned localhost URL
5. click **CLICK TO START**
6. play Player 1 normally against the three AI player slots

For fully automated balance experiments use `doom_run_local_bot_deathmatch` in `all_bots` mode.

## P3 boundary

P2.2 proves:

- source-free multiplayer map generation
- deterministic fairness evaluation
- real four-player LinuxDOOM player slots
- configurable local bot opponents
- human + three bots in a browser

It does **not** synchronize separate browsers or machines. P3.0 will replace the single-process platform boundary with a real online transport, initially a WebSocket relay, while reusing the deathmatch map, fairness and bot infrastructure built here.
