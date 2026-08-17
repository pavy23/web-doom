# Web DOOM MCP Authoring Plane

This directory contains the local MCP authoring/control layer for the direct LinuxDOOM WebAssembly port.

It connects an MCP client such as Claude Code, Cursor, Codex or the MCP Inspector to a **live running DOOM simulation**, records selected world edits, exports them as a real PWAD, and can now load that PWAD back into the same running browser session as the next authoring baseline.

Current MCP version: **0.4.0**

## What v0.4 proves

```text
AI instruction
   ↓
MCP live inspection
   ↓
actor / sector edits
   ↓
LinuxDOOM playtest
   ↓
ChangeSet journal
   ↓
PWAD export
   ↓
local .wad file
   ↓
PWAD validation + reload
   ↓
LinuxDOOM native WAD override
   ↓
current map rebuilt
   ↓
ChangeSet reset
   ↓
next AI iteration
```

This closes the first **author → persist → reload → verify → iterate** loop. The MCP layer is therefore no longer only a live cheat/debug surface; it is becoming a small AI-native level-authoring pipeline.

## Architecture

```text
MCP client
   │ stdio
   ▼
mcp/server.js
   ├── semantic MCP tools
   ├── localhost HTTP proxy  http://127.0.0.1:3777/
   ├── WebSocket /control
   └── local PWAD store -> mcp/exports/
                         │
                         ▼
                  browser shell
                         │
                  window.DoomControl
                         │
            Emscripten ccall + FS
                  │               │
                  ▼               ▼
          doom_control.c      doom_reload.c
          ├── live state      ├── PWAD validation
          ├── actor edits     ├── lumpcache growth
          ├── sector edits    ├── W_AddFile()
          ├── ChangeSet       └── G_InitNew()
          └── PWAD writer
                  │
                  ▼
           LinuxDOOM runtime
```

The normal public GitHub Pages game does **not** connect to localhost. MCP authoring mode is used through the local proxy so the game and control WebSocket share `127.0.0.1`.

## Requirements

- Node.js 20 or newer
- npm
- a local MCP client, or the MCP Inspector

## Install

```bash
git clone https://github.com/pavy23/web-doom.git
cd web-doom
git checkout direct-linuxdoom
cd mcp
npm install
```

## Quick manual test

Start the local bridge:

```bash
npm start
```

Open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**. When attached, the DOOM top bar shows **MCP CONNECTED**.

Health/debug endpoint:

```text
http://127.0.0.1:3777/health
```

## MCP Inspector

```bash
npx @modelcontextprotocol/inspector node server.js
```

Then start DOOM through `http://127.0.0.1:3777/` before calling live tools.

## MCP client configuration

Configure `server.js` as a local **stdio** MCP server:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/server.js"]
}
```

When an MCP host launches the server, do not also run `npm start` on the same port.

# Tools

## Read / perception

### `doom_bridge_status`

Reports MCP version, live browser connection, localhost play URL and PWAD export directory.

### `doom_get_state`

Reads episode/map/skill/tic, current sector, player state, ammunition/statistics and live enemies.

Each enemy includes:

- canonical name and numeric type
- health and x/y/z
- distance from player
- relative view angle
- LinuxDOOM `P_CheckSight()` result
- forward-90-degree `visible` flag

### `doom_get_enemies`

Nearest-first enemy query with optional:

- `visibleOnly`
- `maxDistance`
- `limit`

### `doom_get_sectors`

Reads runtime sectors with:

- index / current-sector flag
- floor / ceiling height
- light level
- special
- tag
- approximate sound-origin coordinates
- player distance

### `doom_get_changeset`

Shows persistent authoring edits made **since the current IWAD/PWAD baseline was loaded**.

Current persistent operations:

```text
sector light edit  -> SECTORS patch
spawn enemy        -> THINGS append
remove map enemy   -> THINGS removal
remove new spawn   -> cancel pending append
```

## Live authoring mutations

### `doom_set_sector_light`

Sets sector light `0..255` immediately and records the edit for PWAD export.

### `doom_spawn_enemy`

Spawns one to eight shareware-safe enemies and records successful spawns as persistent `THINGS` entries.

Supported public-demo types:

- `zombieman`
- `shotgun_guy`
- `imp`
- `demon`
- `spectre`
- `baron_of_hell`

Spawns go through `P_SpawnMobj()` and `P_CheckPosition()`.

### `doom_remove_nearest_enemy`

Removes the nearest enemy through `P_RemoveMobj()`.

An original map actor becomes a persistent `THINGS` removal. Removing an actor created during the current authoring pass cancels its pending spawn instead.

## Play/debug-only mutations

These are intentionally **not** serialized into level content:

- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

# PWAD persistence

## `doom_export_pwad`

Exports the current `ExMy` map as a standard PWAD.

The complete map lump set is retained:

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

During export:

- `THINGS` is rebuilt from the current baseline plus actor ChangeSet.
- `SECTORS` is copied and patched with light edits.
- remaining map lumps are copied unchanged.
- the C engine writes a standard `PWAD` header/directory into Emscripten FS.
- browser sends the binary through the local WebSocket.
- `mcp/server.js` validates it and writes it under `mcp/exports/`.

Example:

```text
Export these changes as horror_e1m1_v1.wad.
```

Set `DOOM_MCP_EXPORT_DIR` to use another output folder.

## `doom_list_exports`

Lists `.wad` iterations available in the local export directory, newest first.

Example:

```text
Show me the PWAD versions we have exported so far.
```

## `doom_load_pwad`

Loads an exported PWAD into the **currently running browser DOOM** and makes it the new authoring baseline.

Example:

```text
Load horror_e1m1_v1.wad and make it our new baseline.
```

The load path is deliberately defensive:

1. Node reads only a filename from the configured export directory; paths/traversal are rejected.
2. Node validates `PWAD` magic, directory bounds and every lump's byte range.
3. Node confirms the file contains the currently running `E#M#` marker.
4. Browser writes the validated bytes into Emscripten FS.
5. `doom_reload.c` independently validates the PWAD and canonical map lump order.
6. Before runtime `W_AddFile()`, the adapter grows LinuxDOOM's startup-sized `lumpcache` and zeroes the new slots.
7. `W_AddFile()` appends the PWAD after the IWAD/older iterations.
8. LinuxDOOM's normal backwards lump lookup makes the newest PWAD override earlier map lumps.
9. `G_InitNew()` rebuilds the current level through the original `P_SetupLevel()` path.
10. the authoring ChangeSet is reset, so the imported PWAD becomes the new baseline.

The browser session and audio backend remain alive; only the DOOM level is rebuilt.

### Protecting unsaved work

If the current ChangeSet contains edits, `doom_load_pwad` refuses by default:

```text
Unexported authoring changes are pending.
```

Export first, or explicitly pass:

```json
{
  "filename": "horror_e1m1_v1.wad",
  "discardChanges": true
}
```

This explicit flag is intended for the common workflow where the current ChangeSet has just been exported and the new file is being loaded as its replacement baseline.

## `doom_reload_current_map`

Rebuilds the map from the latest IWAD/PWAD baseline already loaded in this browser session.

This is useful when a live authoring experiment should be discarded without importing another file. Pending changes receive the same `discardChanges` protection.

# Recommended AI authoring workflow

A complete iteration now looks like:

```text
1. doom_get_state / doom_get_sectors / doom_get_enemies
2. AI proposes edits
3. doom_set_sector_light / spawn / remove
4. human plays immediately
5. doom_get_changeset
6. adjust until acceptable
7. doom_export_pwad filename=v1.wad
8. doom_load_pwad filename=v1.wad discardChanges=true
9. verify state/sector/enemies after map restart
10. continue editing
11. export v2.wad
```

A natural-language example:

```text
Inspect E1M1 and make the opening area darker.
Reduce the nearby enemies, then add three imps deeper in the room.
Let me play it.

[after playtest]
Export this as horror_e1m1_v1.wad.
Load that file back as our new baseline.
Now inspect it again and make the next room slightly brighter.
```

# Why runtime PWAD append needs special handling

Vanilla LinuxDOOM's `W_AddFile()` can append new lump directory entries, and `W_CheckNumForName()` searches from the end so later files override earlier ones. However `W_InitMultipleFiles()` allocates `lumpcache` only once during startup.

A naive runtime `W_AddFile()` therefore leaves the cache array too small for new lump indices. `doom_reload.c` validates the incoming lump count and grows `lumpcache` **before** appending the PWAD. This preserves the original lookup semantics without allowing new map lumps to index past the cache allocation.

Runtime imports are currently capped at **32 per browser session**, because LinuxDOOM's original WAD architecture keeps appended file handles/directories around rather than providing a modern unload operation.

# Security / integrity boundary

The MCP bridge does not expose arbitrary WASM memory.

The authoring path uses explicit operations and original engine systems:

- sight: `P_CheckSight()`
- spawn: `P_SpawnMobj()`
- placement: `P_CheckPosition()`
- removal: `P_RemoveMobj()`
- player teleport: `P_TeleportMove()`
- runtime WAD override: `W_AddFile()`
- map rebuild: `G_InitNew()` → `P_SetupLevel()`

Both export and import use historical DOOM on-disk WAD/map layouts rather than a private replacement level format.

# Current limitations

v0.4 persists only edits that can be safely represented without rebuilding BSP/topology data:

- sector light changes ✅
- actor spawn/remove ✅
- PWAD export ✅
- PWAD reload as next baseline ✅
- floor/ceiling geometry changes ❌
- linedef/door persistence ❌
- vertex/sector topology changes ❌
- texture changes ❌
- multiple map ChangeSets in one authoring session ❌

Geometry/topology edits can require regenerating `SEGS`, `SSECTORS`, `NODES`, `REJECT` and `BLOCKMAP`; they should not be treated as simple runtime memory patches.

# Next milestone

With persistence/reload closed, the next useful step is **safe linedef/door authoring**: identify existing doors/triggers, edit only fields that do not require BSP regeneration, persist those `LINEDEFS`/`SIDEDEFS` changes, then use the v0.4 export/reload loop to playtest them.

After that, the project can move toward automated AI playtesting, screenshots/vision, exact-tic stepping and snapshot/rewind.
