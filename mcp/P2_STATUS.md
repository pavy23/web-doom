# P2 Status

Current branch: `p2-blank-map-generation`

## P2.0 — Blank Map Generation ✅

Completed in this branch:

- source-free canonical Doom map marker + 10 map lumps
- Vanilla-runtime-safe two-sector generated seed with Player 1 start, internal portal and optional exit
- shareware-E1M1-proven seed materials (`STARTAN3`, `FLOOR4_8`, `CEIL3_5`)
- generated seed geometry marked AI-authored (`originalCounts = 0`)
- dedicated P2 MCP server composed on top of P1.4
- atomic generated-map transactions using `EpisodeWorkspace`
- P1.1 THINGS / P1.2 semantic geometry on generated maps
- P1.3 navigation trial on generated maps
- P1.4 diagnosis and repair on generated geometry with legacy repair disabled
- pinned ZDBSP build/export
- Vanilla derived-lump reference checks for SEG/SSECTOR/NODE/BLOCKMAP
- seed-only real LinuxDOOM boot through the standard runtime warp path
- full source-free generation → semantic extension → deliberate defect → P1.4 repair → ZDBSP → LinuxDOOM autonomous replay regression
- full P0 through P1.4 regression retained on the P2 CI gate

P2.0 is considered complete only on green GitHub Actions heads; documentation updates continue to run the same full gate.

## Next

- P2.1 Game-Design Evaluator
- P2.2 Multiplayer / Deathmatch Generator
- later P3 runtime milestone: browser online multiplayer transport, starting with a WebSocket relay
