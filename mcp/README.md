# Web DOOM MCP Control Plane

This directory contains the local MCP control layer for the direct LinuxDOOM WebAssembly port.

It connects an MCP client (Claude Code, Cursor, Codex or the MCP Inspector) to a **live running DOOM simulation** instead of merely launching DOOM inside an MCP UI.

Current MCP version: **0.2.0**

## Architecture

```text
MCP client
   │ stdio
   ▼
mcp/server.js
   ├── MCP tools
   ├── local HTTP proxy  http://127.0.0.1:3777/
   └── WebSocket /control
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
                         │
                         ▼
              LinuxDOOM live state
```

The local HTTP server proxies the published `/direct/` build so the game and control WebSocket share the same localhost origin. The normal public GitHub Pages build does not attempt to open a local MCP connection.

## Requirements

- Node.js 20 or newer
- npm
- a local MCP client, or the MCP Inspector

## Install

From a clone of this repository:

```bash
git checkout direct-linuxdoom
cd mcp
npm install
```

## Quick manual test

Start the MCP server directly:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**. When the browser bridge connects, the DOOM top bar shows **MCP CONNECTED**.

The health endpoint is also available for debugging:

```text
http://127.0.0.1:3777/health
```

## MCP Inspector

From the `mcp` directory:

```bash
npx @modelcontextprotocol/inspector node server.js
```

Connect in the Inspector, then open `http://127.0.0.1:3777/` in a browser and start DOOM before calling live game tools.

## MCP client configuration

Configure the server as a local **stdio** MCP server. Use an absolute path on your machine:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/server.js"]
}
```

The MCP host owns the `server.js` process. Do not also run `npm start` at the same time unless you set a different `DOOM_MCP_PORT`, otherwise both processes will try to bind port 3777.

## Tools

### `doom_bridge_status`

Reports whether a DOOM browser is connected and returns the localhost play URL.

### `doom_get_state`

Reads live simulation state, including:

- episode / map / skill / game tic / level time
- player health, armor and current weapon
- player x/y/z and view angle
- bullets, shells, cells and rockets
- kill / item / secret counters
- total map kills / items / secrets
- all currently alive kill-counting enemies

Each enemy now includes:

- canonical enemy `name`
- original numeric `type`
- health and x/y/z
- distance from the player
- relative angle from the player's facing direction
- `lineOfSight`, calculated by LinuxDOOM `P_CheckSight()`
- `visible`, meaning line-of-sight **and** within the forward 90-degree view cone

### `doom_get_enemies`

Queries the enemy list and sorts it nearest-first.

Optional filters:

- `visibleOnly`
- `maxDistance`
- `limit`

Example intent:

```text
Tell me which enemies I can currently see.
```

### `doom_heal`

Adds health to the active player, capped at 200.

### `doom_give_ammo`

Adds one of `bullets`, `shells`, `cells`, or `rockets`. The engine's current max-ammo value is respected.

### `doom_teleport`

Moves the player to integer map coordinates using LinuxDOOM's own collision-aware `P_TeleportMove()` path. A blocked destination is reported as an error instead of writing arbitrary coordinates into WASM memory.

### `doom_spawn_enemy`

Spawns one to eight enemies in a fan in front of the player.

The public Shareware build intentionally limits spawning to Episode-1-safe assets:

- `zombieman`
- `shotgun_guy`
- `imp`
- `demon`
- `spectre`
- `baron_of_hell`

Parameters:

- `type`
- optional `count` (`1..8`)
- optional `distance` (`64..1024` map units, default `160`)

The implementation calls LinuxDOOM `P_SpawnMobj()`, checks each requested position with `P_CheckPosition()`, and removes blocked spawns. Successful monsters are attached to the original thinker/actor simulation and target the player.

Example intent:

```text
Spawn three imps in front of me.
```

### `doom_remove_nearest_enemy`

Removes the nearest live enemy with LinuxDOOM `P_RemoveMobj()`.

Optional parameters:

- `visibleOnly`
- `maxDistance`

Example intent:

```text
Remove the nearest enemy I can see.
```

## Security boundary

The MCP bridge does **not** expose raw WASM memory. JavaScript can only call functions explicitly exported by `direct-port/doom_control.c`.

Mutation helpers also go through original engine operations where possible:

- sight: `P_CheckSight()`
- spawn: `P_SpawnMobj()`
- spawn collision validation: `P_CheckPosition()`
- removal: `P_RemoveMobj()`
- player teleport: `P_TeleportMove()`

The WebSocket control bridge auto-connects only when the game is loaded from `localhost` or `127.0.0.1`, which is how the local MCP proxy serves it.

## Current milestone

Version 0.2 proves this path:

```text
LLM
 ↓
MCP semantic command
 ↓
query live enemies / choose actor type
 ↓
local bridge
 ↓
explicit WASM C API
 ↓
LinuxDOOM sight + actor + collision systems
 ↓
live game-world mutation
```

Good next additions are sector/light editing, door/line activation, exact-tic stepping, save/restore snapshots and frame capture.
