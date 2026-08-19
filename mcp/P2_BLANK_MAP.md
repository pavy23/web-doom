# P2.0 — Source-Free Blank Map Generation

P2.0 removes the dependency on an existing Doom map marker. It creates a canonical Doom map from scratch and feeds it into the proven P0 through P1.4 pipeline.

## Core idea

```text
no legacy map marker
      ↓
canonical map marker + 10 map lumps
      ↓
runtime-safe generated seed
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

`SEGS`, `SSECTORS`, `NODES`, `REJECT`, and `BLOCKMAP` begin empty and are derived by the pinned ZDBSP pipeline before runtime use.

## Runtime-safe seed map

The default generated seed is intentionally small but contains two connected sectors instead of one:

- one rectangular footprint split into left/right sectors
- six outer one-sided walls
- one two-sided internal portal
- Player 1 start in sector 0
- one optional S1 exit wall (`special 11`) on the outer boundary
- shareware-E1M1-proven defaults: `STARTAN3`, `FLOOR4_8`, `CEIL3_5`
- 128 map-unit ceiling height by default

The two-sector layout is deliberate. A single convex sector lets ZDBSP emit a zero-byte `NODES` lump, which is not a safe Vanilla LinuxDOOM runtime baseline. The generated two-sector seed produces a real BSP node and passes both the structural verifier and LinuxDOOM runtime boot.

The seed is not treated as legacy geometry. Its `originalCounts` boundary is reset to zero, so P1.4 can repair generated seed geometry without requiring `allowLegacyGeometry=true`.

## MCP entry point

```text
mcp/p2_blank_server.js
```

`npm start` on the P2.0 branch launches this server. `npm run start:p1.4` keeps the previous completed P1.4 entry point available.

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

The P1.4 server is composed underneath P2, so the existing P0/P1 tools for legacy-map sessions remain available too.

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

P2.0 is complete when CI proves all of the following:

1. an empty source-free canonical map marker can be serialized;
2. the runtime-safe generated seed validates and produces non-empty Vanilla BSP data;
3. the seed itself cold-boots in real LinuxDOOM through the standard runtime warp path;
4. P1.2 can extend the generated geometry;
5. a deliberately broken generated portal is diagnosed and repaired by P1.4 with legacy repair disabled;
6. ZDBSP produces valid derived map lumps with checked SEG/SSECTOR/NODE/BLOCKMAP references;
7. real LinuxDOOM cold-boots the generated-and-extended PWAD;
8. the autonomous exact-tic agent crosses into the generated target sector.

## Not in P2.0

P2.0 creates and safely extends valid source-free maps; it does not yet attempt to make a whole map interesting from a high-level game-design brief. That belongs to later P2 work:

- P2.1 — game-design evaluator / pacing and resource scoring
- P2.2 — multiplayer/deathmatch map generation and fairness evaluation

Online networking is a separate runtime milestone after generated multiplayer maps are stable. The current browser platform driver intentionally uses a single-player `i_net_web.c` shim; a later phase can replace that transport while preserving LinuxDOOM's game/network core.
