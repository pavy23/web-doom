# Web DOOM MCP Authoring Plane

This directory contains the local MCP authoring/control layer for the direct LinuxDOOM WebAssembly port.

The project now supports a closed AI authoring loop over an existing DOOM map: inspect the live simulation, edit actors/lighting/door semantics/materials, playtest immediately, export a real PWAD, reload that PWAD as the next baseline, and continue iterating.

Current MCP version: **0.6.0**

## What v0.6 adds

v0.6 is the last planned low-level authoring expansion before moving to AI playtest/vision.

```text
AI inspection
   ↓
nearby sectors / linedefs / sidedefs
   ↓
valid IWAD visual asset list
   ↓
wall texture + floor/ceiling flat edits
   ↓
combined ChangeSet
   ↓
THINGS + LINEDEFS + SIDEDEFS + SECTORS
   ↓
PWAD export
   ↓
reload as next baseline
```

The important boundary remains unchanged: **existing geometry only**. v0.6 does not move vertices, create rooms or rebuild BSP-derived data.

## Architecture

```text
MCP client
   │ stdio
   ▼
mcp/server.js
   ├── semantic inspection / mutation tools
   ├── localhost HTTP proxy
   ├── WebSocket /control
   └── PWAD store -> mcp/exports/
                         │
                         ▼
                  browser shell
                         │
                  window.DoomControl
                         │
                 Emscripten ccall
      ┌──────────────────┼──────────────────┐
      ▼                  ▼                  ▼
 doom_control.c     doom_linedefs.c    doom_visuals.c
 actor/sector       door/trigger       material authoring
 ChangeSet/PWAD     LINEDEFS patch     SIDEDEFS/SECTORS
      └──────────────────┼──────────────────┘
                         ▼
                    doom_reload.c
                         ▼
                  LinuxDOOM runtime
```

## Setup

Requirements: Node.js 20+, npm and an MCP client (or MCP Inspector).

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout direct-linuxdoom
cd mcp
npm install
npm start
```

Open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**. The top bar shows **MCP CONNECTED** when attached.

For MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node server.js
```

For another MCP host, configure `server.js` as a local stdio server using an absolute path. Do not also run a second `npm start` on the same port.

# Inspection tools

## `doom_bridge_status`

Reports MCP version, browser connection, play URL and export directory.

## `doom_get_state`

Reads map/player/current-sector/statistics and live enemy state.

## `doom_get_enemies`

Returns enemies nearest-first with optional visibility and distance filters.

## `doom_get_sectors`

Reads sector floor/ceiling height, light, special, tag and approximate distance.

## `doom_get_linedefs`

Reads nearby linedefs with special/action, tag, flags, front/back sectors and geometry references.

## `doom_get_visuals`

Reads current visual material assignments without touching geometry.

Sector entries include:

- `floorFlat`
- `ceilingFlat`
- light level
- current-sector flag
- approximate distance

Wall entries include:

- linedef index
- front/back side
- sidedef index
- sector index
- `top`
- `middle`
- `bottom`
- approximate distance

Example:

```text
Inspect the current room and tell me which wall textures and floor/ceiling flats it uses.
```

## `doom_list_visual_assets`

Lists **actual loaded** visual names that can safely be assigned.

Parameters:

- `kind`: `all`, `wall`, or `flat`
- `query`: optional substring filter
- `limit`

Wall texture names come from the loaded `TEXTURE1/TEXTURE2` definitions. Flat names come from the active `F_START..F_END` range.

The AI should call this before choosing replacement visuals instead of inventing asset names.

# Persistent authoring tools

## Actors

- `doom_spawn_enemy`
- `doom_remove_nearest_enemy`

These persist as `THINGS` additions/removals.

## Lighting

- `doom_set_sector_light`

Persists as a `SECTORS` light-level patch.

## Door / trigger semantics

- `doom_set_linedef_action`

Uses allow-listed Vanilla door presets and persists `special/tag` into `LINEDEFS`.

## Wall materials

### `doom_set_wall_texture`

Changes one existing linedef sidedef texture slot:

```text
line: existing linedef index
side: front | back
slot: top | middle | bottom
texture: 1..8 character DOOM texture name
```

The engine validates the name with LinuxDOOM `R_CheckTextureNumForName()` before changing runtime state. Invalid names are rejected.

The edit is journaled and written into the historical 30-byte `mapsidedef_t` record in `SIDEDEFS` during export.

Example:

```text
Find a darker metal wall texture available in this IWAD and use it on the current room's visible wall.
```

## Floor / ceiling materials

### `doom_set_sector_flat`

Changes an existing sector's `floor` or `ceiling` flat.

The requested name must resolve to a lump inside the currently loaded flat namespace (`F_START..F_END`). The runtime sector updates immediately and the name is persisted in `SECTORS`.

Example:

```text
Use a darker valid floor flat for the sector I am standing in.
```

# Playtest-only tools

These deliberately do not become level content:

- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`
- `doom_activate_linedef`

`doom_activate_linedef` invokes original `P_UseSpecialLine()` so a door/trigger can be tested live, but the activation event itself is not serialized.

# Combined ChangeSet

`doom_get_changeset` now combines all persistent journals since the current IWAD/PWAD baseline was loaded:

```text
actor spawn/remove      -> THINGS
linedef special/tag     -> LINEDEFS
wall texture            -> SIDEDEFS
sector light            -> SECTORS
floor/ceiling flat      -> SECTORS
```

The server reports counts for:

- sector light edits
- spawned things
- removed things
- linedef edits
- sidedef texture edits
- sector flat edits

If an edit is changed back to its baseline value, its visual journal entry becomes inactive rather than producing a redundant PWAD difference.

# PWAD export / reload

## `doom_export_pwad`

Exports a standard current-map PWAD containing:

```text
ExMy
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

v0.6 rewrites or patches:

```text
THINGS    actor placement
LINEDEFS  special / tag
SIDEDEFS  top / middle / bottom wall texture names
SECTORS   light + floor / ceiling flat names
```

The following topology/BSP-derived lumps are copied unchanged:

```text
VERTEXES
SEGS
SSECTORS
NODES
REJECT
BLOCKMAP
```

This is intentional: v0.6 is **semantic/material authoring over existing geometry**, not a geometry editor.

## `doom_list_exports`

Lists local `.wad` iterations in `mcp/exports/` (or `DOOM_MCP_EXPORT_DIR`).

## `doom_load_pwad`

Validates a local export in Node and C, appends it with LinuxDOOM `W_AddFile()`, then rebuilds the current map through `G_InitNew()` / `P_SetupLevel()`.

The imported PWAD becomes the new authoring baseline, so all actor/sector/linedef/visual ChangeSets reset together.

## `doom_reload_current_map`

Rebuilds the current map from the latest loaded baseline without adding another PWAD.

Both load and reload protect pending unexported edits. Explicit `discardChanges: true` is required to discard them.

# Example v0.6 authoring conversation

```text
Inspect the room I am standing in, including its visual materials.
List some darker wall textures and floor flats that actually exist in this IWAD.

Make this room feel more industrial and threatening:
- lower the light to around 40
- replace two nearby wall textures with darker valid alternatives
- replace the floor with a darker valid flat
- add two imps deeper in the room
- make the exit door a reusable button-open door

Show me the full ChangeSet.
Let me play it.
Export it as horror_e1m1_v4.wad.
Load that file as the new baseline and verify the materials survived reload.
```

# Security / integrity boundary

The MCP bridge does not expose arbitrary WASM memory.

Visual authoring is bounded by explicit engine calls:

- wall validation: `R_CheckTextureNumForName()`
- flat validation: loaded WAD flat namespace
- actor placement: `P_SpawnMobj()` / `P_CheckPosition()`
- actor removal: `P_RemoveMobj()`
- sight: `P_CheckSight()`
- door playtest: `P_UseSpecialLine()`
- runtime WAD override: `W_AddFile()`
- map rebuild: `G_InitNew()` → `P_SetupLevel()`

# Current authoring limits

v0.6 can persist:

- actor spawn/remove ✅
- sector light ✅
- linedef door/action special + tag ✅
- sidedef top/middle/bottom texture ✅
- sector floor/ceiling flat ✅
- PWAD export/reload iteration ✅

Still intentionally out of scope:

- vertex movement / new rooms ❌
- floor/ceiling height geometry editing ❌
- adding/removing linedefs or sectors ❌
- custom new texture graphics inside the PWAD ❌
- BSP/node/blockmap regeneration ❌
- multi-map project authoring ❌

# Next milestone: v0.7 AI Playtest / Vision

Low-level authoring is now sufficient for the experiment. The next milestone should stop expanding the map-edit API and instead let the AI **observe and evaluate its own result**.

Planned direction:

```text
AI edit
   ↓
run DOOM
   ↓
frame capture + structured state
   ↓
AI evaluation
   ↓
revision proposal
   ↓
next ChangeSet / PWAD
```

Likely v0.7 capabilities:

- frame/screenshot capture
- pause/resume
- exact `run_tics(n)` control
- input injection for bounded playtest actions
- structured playtest telemetry
- first AI critique/revision loop
