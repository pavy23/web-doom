# Web DOOM MCP Control Plane

This directory contains the first MCP control layer for the direct LinuxDOOM WebAssembly port.

It connects an MCP client (Claude Code, Cursor, Codex or the MCP Inspector) to a **live running DOOM simulation** instead of merely launching DOOM inside an MCP UI.

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
- currently alive kill-counting enemies with type, health and coordinates

### `doom_heal`

Adds health to the active player, capped at 200.

### `doom_give_ammo`

Adds one of:

- `bullets`
- `shells`
- `cells`
- `rockets`

The engine's current max-ammo value is respected.

### `doom_teleport`

Moves the player to integer map coordinates using LinuxDOOM's own collision-aware `P_TeleportMove()` path. A blocked destination is reported as an error instead of writing arbitrary coordinates into WASM memory.

## Current scope

This is intentionally a small first control surface. It proves the complete path:

```text
LLM → MCP tool → local bridge → JavaScript → WASM C API → live DOOM engine
```

The next useful engine tools are expected to include:

- named enemy/type decoding
- nearest/visible enemy queries
- spawn/remove actor
- sector light/floor/ceiling inspection and edits
- door/line activation
- pause and exact-tic stepping
- save/restore simulation snapshots
- frame capture
- WAD/PWAD inspection and live content edits

## Security boundary

The MCP bridge does **not** expose raw WASM memory. JavaScript can only call functions explicitly exported by `direct-port/doom_control.c`.

The WebSocket control bridge auto-connects only when the game is loaded from `localhost` or `127.0.0.1`, which is how the local MCP proxy serves it.
