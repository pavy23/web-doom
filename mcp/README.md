# Web DOOM MCP — v2 Structural Geometry Authoring

This directory contains the local MCP control plane for the direct LinuxDOOM WebAssembly port.

Current MCP version: **2.0.0**.

v2 retains every v1.1 capability and adds **validated structural map editing**:

```text
MCP-host AI
   │
   ├─ v1 semantic authoring / PWAD checkpointing
   ├─ autonomous playtest / vision / evaluation
   ├─ live cheats + audio diagnostics
   └─ v2 structural geometry authoring
          │
          ▼
     Doom Geometry IR
          │
     deterministic validation
          │
          ▼
     pinned ZDBSP WASM
     nodes + blockmap + REJECT rebuild
          │
          ▼
     candidate PWAD
          │
     binary verification
          │
          ▼
     LinuxDOOM reload / playtest
```

The AI never writes BSP nodes directly. It edits map primitives or semantic room/corridor operations; deterministic code rebuilds derived lumps before LinuxDOOM is allowed to load the result.

## Setup

Requirements: Node.js 20+, npm and an MCP client.

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout direct-linuxdoom
cd mcp
npm install
npm start
```

`npm start` launches **`geometry_server.js`**, which composes all earlier MCP tools plus geometry v2.

Open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**.

Local bridges:

```text
127.0.0.1:3777/control       semantic authoring / PWAD
127.0.0.1:3778/playtest      vision / telemetry / exact-tic / AI input
127.0.0.1:3779/orchestrate   closed-loop v1 design sessions
127.0.0.1:3780/cheats        live cheats + audio diagnostics
127.0.0.1:3781/geometry      structural geometry snapshot / reload
```

Generic MCP host configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/geometry_server.js"]
}
```

If the MCP host launches `geometry_server.js`, do not also run `npm start` on the same ports.

## Grok Build

If an older Grok MCP entry points at `cheat_server.js`, replace it with v2:

```powershell
grok mcp remove web-doom
grok mcp add web-doom -- node "C:\absolute\path\web-doom\mcp\geometry_server.js"
grok mcp doctor web-doom
```

Then open the local browser URL above and start DOOM.

# v2 geometry workflow

A structural session always starts from an ordinary playable PWAD snapshot of the current map.

```text
doom_begin_geometry_session
      ↓
inspect Geometry IR
      ↓
small bounded edits
      ↓
doom_geometry_validate
      ↓
doom_geometry_build
      ↓
LINEDEFS / SIDEDEFS / VERTEXES / SECTORS rewritten
SEGS / SSECTORS / NODES / BLOCKMAP / REJECT rebuilt
      ↓
verified candidate .wad
      ↓
LinuxDOOM reload
```

If a candidate is worse or invalid:

```text
doom_geometry_restore_baseline
or
doom_geometry_restore_candidate
```

A verified candidate can be promoted to a final ordinary PWAD with `doom_geometry_finalize`.

# Semantic geometry tools

## `doom_geometry_add_room`

Extrudes a rectangular room from an existing **one-sided wall**.

The selected linedef becomes an open two-sided portal. The new room inherits valid floor/ceiling materials and heights from the source sector unless overridden.

Conceptual request:

```text
현재 시작방의 동쪽 한쪽 벽을 찾아서
깊이 192짜리 새 방을 바깥쪽으로 추가해.
```

The operation creates:

```text
1 new sector
2 new outer vertices
1 new back sidedef on the former wall
3 outer wall sidedefs
3 outer linedefs
```

and converts the former blocking wall into a portal.

## `doom_geometry_resize_room`

Changes the extrusion depth of a room created in the current unapplied workspace.

## `doom_geometry_delete_room`

Removes a generated room while it is still the latest geometry edit. For already-applied candidates, use candidate/baseline restore instead.

## `doom_geometry_add_corridor`

Connects two facing one-sided walls using a new corridor sector.

For safety the current semantic primitive requires the selected walls to be:

- one-sided,
- parallel,
- approximately equal length,
- facing each other on their outside/left sides.

Both walls become portals and deterministic side walls close the corridor.

# Low-level geometry tools

These are available for precise agents and debugging, but semantic operations are preferred:

- `doom_geometry_add_vertex`
- `doom_geometry_move_vertex`
- `doom_geometry_add_sector`
- `doom_geometry_add_sidedef`
- `doom_geometry_add_linedef`
- `doom_geometry_set_sector_heights`
- `doom_geometry_undo`

Use `doom_get_geometry` before low-level editing and `doom_geometry_validate` before every build.

# Geometry inspection and safety

## `doom_geometry_status`

Reports:

- v2 bridge connection,
- local ZDBSP cache state,
- active geometry sessions/candidates.

## `doom_geometry_prepare_nodebuilder`

Prepares the node builder before the first structural build.

The current implementation uses immutable artifacts from:

```text
seanmorris/zdbsp-wasm
commit acc45bf6b2232a75bdbb0b6295822e72e13dfeec
```

The JavaScript wrapper and WASM binary are downloaded to `mcp/.cache/zdbsp/` and verified against their exact Git blob SHA before execution. They are never accepted merely because the download succeeded.

You can pre-cache explicitly:

```bash
npm run prepare-geometry
```

Otherwise the first structural build prepares the cache automatically.

ZDBSP is used in vanilla-compatible mode equivalent to:

```text
--zero-reject
--no-prune
--map=E#M#
```

This rebuilds normal Doom nodes and a full-sized zero REJECT table rather than a ZDoom-only empty REJECT.

## `doom_geometry_validate`

Before invoking the node builder the IR validator checks, among other things:

- signed 16-bit Doom map-coordinate bounds,
- vertex / sidedef / sector references,
- zero-length linedefs,
- sector floor < ceiling,
- new-line proper crossings,
- closed boundary degree for newly-created sectors,
- two-sided linedef consistency warnings.

## post-build verification

After ZDBSP, the candidate is parsed again and must contain non-empty:

```text
SEGS
SSECTORS
NODES
BLOCKMAP
```

and a full `REJECT` of the vanilla-required size:

```text
ceil(number_of_sectors² / 8)
```

Only then can the candidate be applied to the running LinuxDOOM session.

# Session boundaries

`doom_begin_geometry_session` refuses to silently absorb pending actor/light/door/material ChangeSet edits by default.

If those edits are intentionally meant to become the structural baseline, pass:

```text
adoptPendingChanges=true
```

Every applied structural candidate becomes a fresh geometry baseline in memory. Candidate files are retained under:

```text
mcp/exports/
```

Current hard limits:

```text
geometry sessions/process  8
built candidates/session   12
```

Restart the MCP process to clear process-memory geometry sessions.

# Example full v2 test

A useful first test is intentionally small:

```text
1. 현재 E1M1에서 geometry session을 시작해.
2. geometry를 조사해서 안전하게 바깥쪽으로 확장 가능한 one-sided wall 하나를 찾아.
3. 그 벽에서 depth 192의 새 방을 하나 추가해.
4. geometry validation을 실행해.
5. geom_e1m1_v1.wad로 build하고 바로 apply해.
6. 화면을 캡처하고 새 방에 직접 들어가서 playtest해.
7. 필요하면 기존 visual/actor MCP로 조명·텍스처·적을 추가해.
8. 만족하면 geom_e1m1_final.wad로 finalize해.
```

For a corridor:

```text
두 sector 사이에서 서로 마주 보는 one-sided parallel wall을 찾아
corridor로 연결하고 validate/build/apply 해.
```

# Modern desktop controls

The direct browser platform layer now defaults to a modern FPS-style scheme while preserving original arrow-key behavior:

```text
W / S          forward / backward
A / D          strafe left / right
Left / Right   rotate (original behavior)
Up / Down      forward / backward (original behavior)
Mouse X        horizontal turn, roughly 2x previous browser sensitivity
Mouse Y        ignored (no accidental vanilla mouse-forward movement)
Click canvas   Pointer Lock + hide cursor
Esc            release Pointer Lock
Ctrl / J       fire
Space / E      use/open
Shift          run
1..7           weapons
```

A/D reuse LinuxDOOM's original dedicated `key_strafeleft` / `key_straferight` path rather than replacing movement physics.

# v1.1 live debugging retained

Runtime-only tools remain available and never enter PWAD data:

- `doom_cheat_status`
- `doom_set_god_mode`
- `doom_set_noclip`
- `doom_give_arsenal`
- `doom_give_keys`
- `doom_set_health_armor`
- `doom_give_powerup`
- `doom_warp`
- `doom_audio_status`
- `doom_audio_resume`

Disable cheats when evaluating normal-player difficulty.

# v1 closed-loop authoring retained

The full earlier pipeline remains available:

```text
design goal
→ bounded semantic edit
→ PWAD checkpoint / reload
→ autonomous ticcmd playtest
→ PNG + telemetry
→ deterministic evaluation + optional AI vision rubric
→ revision / restore
→ final PWAD
```

Session tools:

- `doom_begin_design_session`
- `doom_run_authoring_iteration`
- `doom_review_design_iteration`
- `doom_get_design_session`
- `doom_restore_design_candidate`
- `doom_finalize_design_session`

Observation/agency tools include:

- `doom_capture_frame`
- `doom_get_playtest_telemetry`
- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_run_input`
- `doom_run_input_sequence`

Existing semantic authoring remains useful after structural edits:

- enemies / objects → `THINGS`
- door/trigger behavior → `LINEDEFS`
- wall textures → `SIDEDEFS`
- lighting / floor / ceiling flats → `SECTORS`

# Current v2 scope

v2 removes the old “no topology changes” limitation, but it is intentionally not an unrestricted CAD kernel.

Supported now:

```text
existing vertex movement
sector height changes
low-level vertex/linedef/sidedef/sector addition
semantic rectangular room extrusion
semantic straight corridor connection
node / subsector / blockmap / REJECT rebuild
candidate reload / rollback / finalization
```

Still deliberately outside the safe semantic surface:

```text
arbitrary curved/free-form room generation
boolean polygon operations
automatic multi-turn corridor routing around obstacles
merging/deleting arbitrary legacy sectors
moving large groups of legacy vertices without spatial planning
```

Those can be added later on top of the same Geometry IR, but they should preserve the same rule: **AI proposes topology; deterministic geometry validation + node building decides whether it is loadable.**
