# P2.0 — Source-Free Blank Map Generation

P2.0 removes the final dependency on an existing Doom map marker. It creates a canonical Doom map from scratch and feeds it into the already-proven P0 through P1.4 pipeline.

## Core idea

```text
no legacy map marker
      ↓
canonical map marker + 10 map lumps
      ↓
seeded valid start room
      ↓
Player 1 start + optional exit
      ↓
all seed geometry marked AI-authored
      ↓
P0 atomic transactions
      ↓
P1.1 THINGS + P1.2 semantic geometry
      ↓
P1.3 navigation / autonomous QA
      ↓
P1.4 diagnosis + conservative repair
      ↓
pinned ZDBSP
      ↓
real LinuxDOOM runtime verification
```

The canonical map sequence is:

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

`SEGS`, `SSECTORS`, `NODES`, `REJECT`, and `BLOCKMAP` begin empty. They are derived by the pinned ZDBSP pipeline before runtime use.

## Seed map

The default generated seed is intentionally minimal:

- one rectangular sector
- four clockwise one-sided walls
- Player 1 start at the center
- one optional S1 exit wall (`special 11`)
- Vanilla-compatible default textures/flats
- 128 map-unit ceiling height by default

The seed is not treated as legacy geometry. Its `originalCounts` boundary is reset to zero, so P1.4 can repair generated seed geometry without requiring `allowLegacyGeometry=true`.

## MCP entry point

```text
mcp/p2_blank_server.js
```

`npm start` on the P2.0 branch launches this server.

Key P2 tools:

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

The P1.4 server is composed underneath P2, so all existing P0/P1 tools for legacy-map sessions remain available too.

## Example MCP flow

```text
Create a new E1M1 blank-map session at 640x480.
Add a six-sided room from the west wall using an atomic blank transaction.
Validate and commit it.
Place an Imp and a shotgun in the new room.
Build the map.
Run navigation analysis from Player 1 to the new room.
Cold-boot LinuxDOOM and autonomously verify that the room is reachable.
If navigation fails, run P2 blank auto-repair and verify again.
```

## Completion gate

P2.0 is complete only when CI proves all of the following:

1. an empty source-free canonical map marker can be serialized;
2. a seeded playable map validates with P0/P1 validators;
3. P1.2 can extend the generated geometry;
4. a deliberately broken generated portal is diagnosed and repaired by P1.4 with legacy repair disabled;
5. ZDBSP produces valid derived map lumps;
6. real LinuxDOOM cold-boots the generated PWAD;
7. the autonomous exact-tic agent crosses into the generated-and-extended target sector.

## Not in P2.0

P2.0 does not yet try to design an entire interesting level from a high-level game-design brief. That belongs to later P2 work:

- P2.1 — game-design evaluator / pacing and resource scoring
- P2.2 — multiplayer/deathmatch map generation and fairness evaluation

Online networking is a separate runtime milestone after generated multiplayer maps are stable. The current browser platform driver intentionally uses a single-player `i_net_web.c` shim; a later phase can replace that transport while preserving LinuxDOOM's game/network core.
