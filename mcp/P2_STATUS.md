# P2 Status

Current branch: `p2-deathmatch-bots`

## P2.0 — Blank Map Generation ✅

Completed on `p2-blank-map-generation`:

- source-free canonical Doom map marker + 10 map lumps
- Vanilla-runtime-safe two-sector generated seed with Player 1 start, internal portal and optional exit
- shareware-E1M1-proven seed materials (`STARTAN3`, `FLOOR4_8`, `CEIL3_5`)
- generated seed geometry marked AI-authored (`originalCounts = 0`)
- atomic generated-map transactions using `EpisodeWorkspace`
- P1.1 THINGS / P1.2 semantic geometry on generated maps
- P1.3 navigation trial on generated maps
- P1.4 diagnosis and repair on generated geometry with legacy repair disabled
- pinned ZDBSP build/export
- Vanilla derived-lump reference checks for SEG/SSECTOR/NODE/BLOCKMAP
- seed-only real LinuxDOOM boot through the standard runtime warp path
- full source-free generation → semantic extension → deliberate defect → P1.4 repair → ZDBSP → LinuxDOOM autonomous replay regression

## P2.1 — Deterministic Game-Design Evaluator ✅

Completed on `p2-game-design-evaluator`:

- built-candidate-only game-design evaluation
- deterministic 0–100 components for reachability, progression, topology, combat, resources and pacing
- `balanced`, `combat` and `exploration` design profiles
- easy/medium/hard THINGS filtering
- loop / branch / dead-end / average-degree topology metrics
- key-aware exit progression and main-path depth
- normalized monster threat / resource support analysis
- path threat/support curves and start-room pressure
- structured issue codes plus recommended follow-up actions
- exact-policy before/after candidate comparison

Acceptance example under the same `balanced / medium` policy:

- under-supported Cyberdemon candidate: 70.3 (C), resources 12.25
- supported candidate after shotgun/ammo/health/armor edits: 83.5 (B), resources 100
- overall delta: +13.2
- resolved: `RESOURCE_STARVATION`, `NO_EARLY_WEAPON`

## P2.2 — Deathmatch Generation, Fairness and Local Bots ✅

Completed on `p2-deathmatch-bots`:

- source-free octagonal ring + center deathmatch arena generator
- 8 deathmatch starts and 4 real Player 1–4 starts
- equal spawn-side shotgun/shell access and contested central rocket launcher
- P0 validation and pinned ZDBSP on generated multiplayer geometry
- deterministic spawn-distance / weapon-access / LOS / route / high-value-item / topology fairness scoring
- before/after fairness comparison with structured issue codes
- real LinuxDOOM `players[0..3]` local multiplayer slots in one browser process
- independent per-player `ticcmd` injection
- engine `P_CheckSight`-based bot perception
- `easy`, `normal`, `hard`, `nightmare` bot skill presets
- local deathmatch respawn compatibility while keeping remote `netgame=false`
- fully automated 4-bot exact-tic matches
- interactive Player 1 keyboard/mouse + Players 2–4 live bots
- per-bot live difficulty changes through `DoomLocalBots`
- reproducible WSL/Windows P2.2 runtime build path
- full P0→P2.1 regression retained in the P2.2 CI gate

Final design acceptance:

- balanced arena: 84.67 (B)
- deliberately unfair arena: 48.2 (F)
- fairness recovery delta: +36.47
- balanced nearest-weapon cost CV: 0.001
- balanced high-value-item cost CV: 0.000
- 8 independent loop-rich spawn network, average 3 immediate route choices

Final four-bot runtime acceptance (700 exact tics):

- Player 1 Easy: 74 decisions, 834 movement units, 0 frags
- Player 2 Normal: 141 decisions, 1524 movement units, 0 frags
- Player 3 Hard: 234 decisions, 4752 movement units, 2 frags
- Player 4 Nightmare: 700 decisions, 5314 movement units, 1 frag
- real damage observed: yes
- real frags observed: yes

Interactive browser acceptance:

- Player 1 remained on normal browser keyboard input with agent override inactive
- Player 2 Easy / Player 3 Hard / Player 4 Nightmare all made live bot decisions
- short-run bot decisions: 14 / 37 / 110

See `P2_DEATHMATCH.md` for architecture, MCP tools and Windows/Grok usage.

## Next

- P3.0 browser online multiplayer transport: two-client WebSocket relay first
- later: remote human + bot-filled lobbies, latency/tic synchronization and multi-client fairness telemetry
