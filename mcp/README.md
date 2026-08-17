# Web DOOM MCP Authoring Plane

This directory contains the local MCP authoring/control layer for the direct LinuxDOOM WebAssembly port.

It connects an MCP client such as Claude Code, Cursor, Codex or the MCP Inspector to a **live running DOOM simulation**, records selected world edits, exports them as a real PWAD, reloads that PWAD as the next baseline, and now also edits safe existing `LINEDEFS` door/trigger behavior.

Current MCP version: **0.5.0**

## What v0.5 adds

```text
AI inspection
   ↓
nearby LINEDEFS / doors
   ↓
existing special + tag semantics
   ↓
optional live activation through P_UseSpecialLine()
   ↓
safe preset edit of special/tag
   ↓
LINEDEFS ChangeSet
   ↓
PWAD export
   ↓
reload as next baseline
```

The important boundary is that v0.5 does **not** move vertices or rebuild geometry. It changes only existing linedef semantic fields (`special` and `tag`), which can be persisted directly in the historical 14-byte `maplinedef_t` record without regenerating BSP-derived lumps.

## Architecture

```text
MCP client
   │ stdio
   ▼
mcp/server.js
   ├── perception / authoring tools
   ├── localhost HTTP proxy
   ├── WebSocket /control
   └── local PWAD store -> mcp/exports/
                         │
                         ▼
                  browser shell
                         │
                  window.DoomControl
                         │
                 Emscripten ccall
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
 doom_control.c    doom_linedefs.c  doom_reload.c
 actor/sector      line semantics    PWAD baseline
 ChangeSet/PWAD    LINEDEFS patch    reload
          └──────────────┼──────────────┘
                         ▼
                  LinuxDOOM runtime
```

The public GitHub Pages build never opens a localhost connection by itself. MCP mode is used through the local proxy at `127.0.0.1`.

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

Then open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**. The top bar shows **MCP CONNECTED** when the browser bridge is attached.

For MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node server.js
```

For an MCP host, configure `server.js` as a local stdio server using an absolute path. Do not also run a second `npm start` on the same port.

# MCP tools

## Inspection

- `doom_bridge_status` — server/browser status and export directory
- `doom_get_state` — map, player, current sector, enemies and stats
- `doom_get_enemies` — nearest/visible enemy query
- `doom_get_sectors` — floor/ceiling/light/special/tag metadata
- `doom_get_linedefs` — nearby linedef/door semantics and geometry references
- `doom_get_changeset` — combined sector/actor/linedef persistent edits

### `doom_get_linedefs`

Returns linedefs with:

- `index`
- `special`
- decoded `action`
- `doorLike`
- `tag`
- flags / two-sided state
- front/back sector indices
- x1/y1/x2/y2
- approximate player distance

Useful filters:

- `maxDistance`
- `doorsOnly`
- `specialsOnly`
- `limit`

Example:

```text
Show me the nearby door-related linedefs within 600 map units.
```

## Persistent authoring

### `doom_set_sector_light`

Changes light `0..255` and persists it as a `SECTORS` patch.

### `doom_spawn_enemy` / `doom_remove_nearest_enemy`

Persist actor additions/removals by rebuilding `THINGS`.

### `doom_set_linedef_action`

Changes only an existing linedef's Vanilla `special` and optional `tag`, and journals that change for `LINEDEFS` export.

Supported bounded presets:

```text
none
manual_raise
manual_open
switch_raise_once
switch_open_once
switch_close_once
button_raise
button_open
button_close
manual_blazing_raise
manual_blazing_open
switch_blazing_raise_once
switch_blazing_open_once
switch_blazing_close_once
button_blazing_raise
button_blazing_open
button_blazing_close
```

Remote switch/button presets normally need a meaningful sector `tag`; inspect the target map's existing tags before changing them. Manual door specials act on the adjacent back sector and usually do not depend on a remote tag.

Example:

```text
Inspect linedef 124. Change it into a reusable door-open button targeting tag 7.
```

### `doom_activate_linedef`

Calls LinuxDOOM's original `P_UseSpecialLine(player, line, 0)` immediately so a selected door/trigger can be playtested.

This activation is **playtest-only**. One-shot specials may consume themselves or animate switch textures at runtime, but that temporary activation is not automatically serialized. Use `doom_set_linedef_action` for the persistent behavior definition.

Example:

```text
Activate linedef 124 now so I can test what it does.
```

## Debug-only tools

These do not become level content:

- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

# Combined ChangeSet

`doom_get_changeset` now combines:

```text
sector light      -> SECTORS
spawn/remove      -> THINGS
linedef special   -> LINEDEFS
linedef tag       -> LINEDEFS
```

PWAD load/reload protection treats any of these as unsaved authoring work.

# PWAD export / reload

`doom_export_pwad` keeps the complete current map lump set:

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

v0.5 export behavior:

- `THINGS`: rebuild actor additions/removals
- `LINEDEFS`: patch journaled `special` and `tag`
- `SECTORS`: patch journaled light levels
- all other current-map lumps: copy unchanged

This is safe for the supported linedef edits because `maplinedef_t` stores `special/tag` independently from BSP topology. Vertices, sidedefs, segs, subsectors and nodes are not rewritten.

`doom_list_exports`, `doom_load_pwad` and `doom_reload_current_map` remain the iterative baseline tools. PWAD import is validated in Node and again in C; LinuxDOOM's lump cache is expanded before runtime `W_AddFile()`, then `G_InitNew()` rebuilds the current level. A successful reload resets actor/sector **and linedef** ChangeSets so the imported file becomes the new baseline.

# Recommended v0.5 workflow

```text
1. doom_get_state
2. doom_get_sectors
3. doom_get_linedefs doorsOnly=true
4. identify an existing door / switch / target tag
5. doom_activate_linedef for a temporary behavior test
6. doom_set_linedef_action for the persistent rule
7. adjust lighting / actors as needed
8. doom_get_changeset
9. playtest
10. doom_export_pwad filename=v1.wad
11. doom_load_pwad filename=v1.wad discardChanges=true
12. inspect again and continue to v2
```

Example natural-language session:

```text
Find the nearest door-related lines.
Tell me which one controls the next room and which sector tag it targets.
Make that door open from a reusable button instead of its current behavior.
Darken the room behind it and add two imps.
Let me test the door now.
Export everything as horror_e1m1_v2.wad and reload it as our baseline.
```

# Integrity boundary

The MCP bridge never exposes arbitrary WASM memory. Relevant original engine paths include:

- `P_CheckSight()` — enemy sight
- `P_SpawnMobj()` / `P_CheckPosition()` — actor creation
- `P_RemoveMobj()` — actor removal
- `P_TeleportMove()` — debug player movement
- `P_UseSpecialLine()` — linedef activation playtest
- `W_AddFile()` — runtime PWAD override
- `G_InitNew()` → `P_SetupLevel()` — map rebuild

Persistent linedef editing is intentionally allow-listed through named presets rather than exposing arbitrary special numbers.

# Current limitations

v0.5 intentionally supports semantic edits that do not require rebuilding map topology:

- sector light ✅
- actor spawn/remove ✅
- existing linedef special/tag ✅
- door/switch activation playtest ✅
- PWAD export/reload ✅
- direct floor/ceiling geometry editing ❌
- vertex / sector topology editing ❌
- sidedef texture authoring ❌
- BSP regeneration ❌
- full new-map generation ❌

The next valuable milestone is **texture/safe sector metadata authoring plus AI playtest scoring / visual inspection**. Geometry creation should come later with an explicit node-builder pipeline rather than pretending runtime topology edits are enough.
