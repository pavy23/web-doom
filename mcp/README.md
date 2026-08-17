# Web DOOM MCP Authoring Plane

This directory contains the local MCP authoring/control layer for the direct LinuxDOOM WebAssembly port.

It connects an MCP client such as Claude Code, Cursor, Codex or the MCP Inspector to a **live running DOOM simulation**, and now also records selected world edits so they can be exported as a playable PWAD.

Current MCP version: **0.3.0**

## Architecture

```text
MCP client
   │ stdio
   ▼
mcp/server.js
   ├── semantic MCP tools
   ├── localhost HTTP proxy  http://127.0.0.1:3777/
   ├── WebSocket /control
   └── local PWAD writer -> mcp/exports/
                         │
                         ▼
                  browser shell
                         │
                  window.DoomControl
                         │
                    Emscripten ccall
                         │
                         ▼
                 doom_control.c
                  ├── live state
                  ├── actor/sector edits
                  ├── ChangeSet journal
                  └── PWAD writer
                         │
                         ▼
              LinuxDOOM live simulation
```

The local HTTP server proxies the published `/direct/` build so the game and control WebSocket share the same localhost origin. The normal public GitHub Pages build does **not** attempt to connect to localhost.

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

Start the local bridge directly:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**. When the browser bridge attaches, the top bar shows **MCP CONNECTED**.

Health/debug endpoint:

```text
http://127.0.0.1:3777/health
```

It reports the current bridge state and PWAD export directory.

## MCP Inspector

From the `mcp` directory:

```bash
npx @modelcontextprotocol/inspector node server.js
```

Then open `http://127.0.0.1:3777/` and start DOOM before calling live tools.

## MCP client configuration

Configure `server.js` as a local **stdio** MCP server. Example:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/server.js"]
}
```

When an MCP host launches the server, do not also run `npm start` on the same port. Both processes would otherwise try to bind `127.0.0.1:3777`.

## Read / perception tools

### `doom_bridge_status`

Reports bridge connection state, the localhost play URL, upstream Pages URL and PWAD export directory.

### `doom_get_state`

Reads live simulation state including:

- episode / map / skill / tic / level time
- current sector index
- player health, armor, weapon and x/y/z/angle
- ammunition and max ammunition
- kill / item / secret statistics
- live kill-counting enemies

Each enemy includes canonical name, numeric type, health, coordinates, distance, relative angle, LinuxDOOM `P_CheckSight()` result and a forward-90-degree `visible` flag.

### `doom_get_enemies`

Returns enemies nearest-first with optional:

- `visibleOnly`
- `maxDistance`
- `limit`

Example:

```text
Tell me which enemies I can currently see.
```

### `doom_get_sectors`

Reads runtime sector data and puts the current sector first.

Each sector includes:

- `index`
- `current`
- floor / ceiling height
- light level
- special
- tag
- approximate sector sound-origin x/y
- distance from the player

Optional filters:

- `maxDistance`
- `limit`

Example:

```text
Inspect the room I am standing in and the nearby sectors.
```

## Live mutation / authoring tools

### `doom_set_sector_light`

Sets a sector light level from `0..255`.

This is an **authoring mutation**: the live engine changes immediately and the edit is recorded in the current ChangeSet so it can be serialized to the map's `SECTORS` lump.

Example:

```text
Make my current room much darker, around light level 32.
```

### `doom_spawn_enemy`

Spawns one to eight enemies in a fan in front of the player.

Shareware-safe types:

- `zombieman`
- `shotgun_guy`
- `imp`
- `demon`
- `spectre`
- `baron_of_hell`

The engine uses `P_SpawnMobj()` and validates placement with `P_CheckPosition()`. Successful spawns receive persistent `mapthing_t` data and are journaled as additions to the exported `THINGS` lump.

Example:

```text
Spawn three imps in front of me.
```

### `doom_remove_nearest_enemy`

Removes the nearest live enemy through `P_RemoveMobj()`.

If the enemy came from the original map, its original `spawnpoint` is journaled as a `THINGS` removal. If it was spawned during the current authoring session, removing it cancels that pending spawn instead of creating a contradictory add/remove pair.

Optional parameters:

- `visibleOnly`
- `maxDistance`

### Play/debug-only mutations

The following tools affect the live session but are deliberately **not serialized into PWAD output**:

- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

This separation prevents temporary playtest cheats from accidentally becoming level content.

## ChangeSet

### `doom_get_changeset`

Returns the authoring journal for the current `ExMy` map.

Current persistent operations:

```text
sector light edit  -> SECTORS record patch
spawn enemy        -> THINGS record append
remove map enemy   -> THINGS record removal
remove new spawn   -> cancel pending THINGS append
```

The ChangeSet is intentionally per-current-map and lives in the running engine. Reloading the page or changing maps starts a fresh authoring session.

## PWAD export

### `doom_export_pwad`

This is the key v0.3 authoring step.

The engine locates the current map marker (`E1M1`, `E1M2`, etc.) and copies the complete Vanilla map lump set:

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

- `THINGS` is rebuilt from the original lump plus the actor ChangeSet.
- `SECTORS` is copied and patched with journaled light edits.
- all other current-map lumps are copied unchanged.
- a standard `PWAD` header/directory is written inside Emscripten FS.
- the browser reads the binary file and sends it through the localhost WebSocket.
- `mcp/server.js` saves the result under `mcp/exports/`.

Example intent:

```text
Export what we changed as horror_e1m1.wad.
```

Typical tool result:

```json
{
  "exported": true,
  "filename": "horror_e1m1.wad",
  "path": "C:/.../web-doom/mcp/exports/horror_e1m1.wad",
  "bytes": 123456,
  "episode": 1,
  "map": 1,
  "changes": {
    "sectorLights": 4,
    "spawnedThings": 3,
    "removedThings": 2
  }
}
```

Set `DOOM_MCP_EXPORT_DIR` before launching the MCP server to choose a different output directory.

## Suggested authoring loop

```text
1. Open DOOM through localhost MCP bridge
2. Ask AI to inspect state / enemies / sectors
3. Make live actor and lighting edits
4. Play the modified level immediately
5. Ask AI to inspect doom_get_changeset
6. Iterate
7. doom_export_pwad
8. load/share the resulting PWAD with a compatible base IWAD/runtime
```

This is the first version where the MCP layer acts as a **content-authoring interface**, not only a live cheat/debug API.

## Security / integrity boundary

The MCP bridge does **not** expose arbitrary WASM memory. JavaScript can call only explicit functions exported by `direct-port/doom_control.c`.

Authoring helpers also reuse original engine operations where possible:

- sight: `P_CheckSight()`
- spawn: `P_SpawnMobj()`
- placement validation: `P_CheckPosition()`
- removal: `P_RemoveMobj()`
- player teleport: `P_TeleportMove()`

PWAD export uses LinuxDOOM's own WAD directory/lump access through `W_CheckNumForName()`, `W_LumpLength()` and `W_ReadLump()` and emits the historical on-disk `mapthing_t` / `mapsector_t` layouts.

## Current limitations

Version 0.3 intentionally persists only edits we can serialize safely without rebuilding the BSP:

- sector light changes ✅
- actor spawn/remove ✅
- floor/ceiling geometry changes ❌
- linedef/door edits ❌
- vertex/sector topology changes ❌
- texture changes ❌
- multi-map ChangeSets ❌

Geometry/topology edits are a later milestone because changing vertices/lines/sectors can require regenerating `SEGS`, `SSECTORS`, `NODES`, `REJECT` and `BLOCKMAP` rather than simply patching runtime memory.

## Next milestone

The next useful step is **door/linedef + safe sector metadata authoring**, followed by PWAD import/reload and AI playtest iteration. Exact-tic stepping, snapshots and frame capture remain later debugging/agent milestones.
