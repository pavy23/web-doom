# P2 Status

Current branch: `p2-game-design-evaluator`

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

## P2.1 — Deterministic Game-Design Evaluator 🚧

Implemented on this branch:

- built-candidate-only game-design evaluation
- deterministic 0–100 components for reachability, progression, topology, combat, resources and pacing
- `balanced`, `combat` and `exploration` design profiles
- easy/medium/hard THINGS filtering
- loop / branch / dead-end / average-degree topology metrics
- key-aware exit progression and main-path depth
- normalized single-player monster threat distribution
- normalized ammo / weapon / health / armor / powerup support analysis
- path threat/support curves and start-room pressure
- structured issue codes plus recommended follow-up actions
- exact-policy before/after candidate comparison
- dedicated P2.1 MCP entry point composed on P2.0
- P2.1 deterministic regression plus complete P2.0 and P0→P1.4 CI gate

Completion gate is green GitHub Actions on the exact P2.1 branch head.

## Next

- P2.2 Multiplayer / Deathmatch Generator + fairness evaluator
- P3.0 browser online multiplayer transport, starting with a two-client WebSocket relay
