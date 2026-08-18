# Web DOOM — Direct LinuxDOOM + AI Authoring MCP v2

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended into an AI-native level authoring, autonomous playtest/evaluation and now **structural geometry authoring** sandbox.

The `/direct/` runtime uses the original LinuxDOOM gameplay/rendering/WAD code with repository-owned browser platform adapters. Chocolate Doom is used only for the pinned Vanilla/DMX-compatible OPL music subsystem, not as the game runtime.

## Play

- Direct build: https://pavy23.github.io/web-doom/direct/
- Earlier doomgeneric comparison build: https://pavy23.github.io/web-doom/
- Development branch: `direct-linuxdoom`

Current MCP version: **2.0.0**

## What v2 adds

Earlier versions already supported:

```text
actors / enemies
sector lighting
wall / floor / ceiling materials
door + trigger behavior
PWAD export / reload
PNG vision + telemetry
exact-tic simulation
autonomous ticcmd player input
design-goal evaluation
bounded closed-loop revisions
live cheats + audio diagnostics
```

v2 adds structural map editing:

```text
AI geometry request
      ↓
Doom Geometry IR
VERTEXES / LINEDEFS / SIDEDEFS / SECTORS
      ↓
deterministic structural validation
      ↓
pinned + hash-verified ZDBSP WASM
      ↓
SEGS / SSECTORS / NODES / BLOCKMAP / REJECT rebuild
      ↓
verified candidate PWAD
      ↓
LinuxDOOM reload
      ↓
AI playtest / vision / evaluation
      ↓
revision, rollback or final WAD
```

The AI never writes BSP nodes directly. Structural edits must pass validation and a deterministic node-builder pass before the running game can load them.

## v2 geometry tools

Semantic operations:

- `doom_geometry_add_room` — extrude a rectangular room from a safe one-sided wall
- `doom_geometry_resize_room`
- `doom_geometry_delete_room`
- `doom_geometry_add_corridor` — connect two facing, parallel, equal-span one-sided walls
- `doom_geometry_set_sector_heights`

Low-level primitives:

- `doom_geometry_add_vertex`
- `doom_geometry_move_vertex`
- `doom_geometry_add_sector`
- `doom_geometry_add_sidedef`
- `doom_geometry_add_linedef`
- `doom_geometry_undo`

Session / validation:

- `doom_geometry_status`
- `doom_geometry_prepare_nodebuilder`
- `doom_begin_geometry_session`
- `doom_get_geometry`
- `doom_geometry_validate`
- `doom_geometry_build`
- `doom_geometry_restore_baseline`
- `doom_geometry_restore_candidate`
- `doom_geometry_finalize`

A structural build writes a real candidate `.wad` under `mcp/exports/`, rebuilds derived Doom map lumps, verifies them and can immediately reload the candidate into LinuxDOOM.

## Node builder

v2 uses immutable artifacts from `seanmorris/zdbsp-wasm` commit:

```text
acc45bf6b2232a75bdbb0b6295822e72e13dfeec
```

The wrapper and WASM binary are cached under `mcp/.cache/zdbsp/` and checked against their exact Git blob SHA before execution.

The vanilla-compatible node build uses:

```text
--zero-reject
--no-prune
--map=E#M#
```

so the candidate gets ordinary Doom nodes/blockmap and a full-sized zero `REJECT` table rather than a ZDoom-only empty representation.

## Modern browser controls

The direct browser platform now defaults to a more modern FPS scheme while preserving the original arrow-key behavior:

```text
W / S          forward / backward
A / D          strafe left / right
Left / Right   rotate
Up / Down      forward / backward
Mouse X        horizontal turn, about 2x previous browser sensitivity
Mouse Y        ignored
Click canvas   pointer lock + hide cursor
Esc            release pointer lock
Ctrl / J       fire
Space / E      use / open
Shift          run
1..7           weapon selection
```

A/D reuse LinuxDOOM's original dedicated strafe bindings; movement physics were not replaced.

## Architecture

```text
LinuxDOOM 1.10 / WASM
        │
        ▼
Browser DoomControl
        │
 ┌──────┼────────┬────────┬────────┬────────┐
 │      │        │        │        │        │
3777   3778     3779     3780     3781
control playtest orchestrate cheats geometry
 │      │        │        │        │
 └──────┴────────┴────┬───┴────────┘
                     ▼
            mcp/geometry_server.js
                     │
                  stdio MCP
                     │
          Grok / Claude / Codex / etc.
```

The public Pages game behaves normally. Local MCP WebSockets activate only when the game is opened through the local MCP proxy.

## Quick start

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

and click **CLICK TO START**.

Generic MCP host configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/geometry_server.js"]
}
```

For Grok Build, point the MCP entry at `mcp/geometry_server.js` rather than the older `cheat_server.js`.

Detailed guide: `mcp/README.md` on the `direct-linuxdoom` branch.

## Example geometry experiment

```text
현재 E1M1에서 geometry session을 시작해.
geometry를 조사해서 바깥으로 안전하게 확장 가능한 one-sided wall 하나를 찾아.
그 벽에 깊이 192의 새 방을 추가해.
validation을 실행해.
geom_e1m1_v1.wad로 build하고 apply해.
새 방으로 직접 이동해서 화면/telemetry로 playtest해.
필요하면 조명, texture, 적을 추가해.
마지막으로 geom_e1m1_final.wad로 finalize해.
```

## Retained v1 capabilities

Closed-loop design sessions remain available:

```text
design goal
→ bounded semantic edits
→ candidate PWAD
→ autonomous exact-tic playtest
→ PNG + telemetry
→ deterministic evaluation + optional AI vision rubric
→ revise / restore
→ final PWAD
```

Runtime-only debugging tools also remain available: god mode, noclip, full arsenal/ammo/keys, health/armor, power-ups, map warp and browser/SDL audio diagnostics. These cheats are not serialized into authored PWADs.

## Audio

Sound effects use direct DMX type-3 decoding through SDL2_mixer.

Music follows a Vanilla/DMX-compatible OPL register path using IWAD `GENMIDI` instrumentation and Nuked OPL3 v1.8 in OPL2-compatible mode. The OPL subsystem is imported from pinned Chocolate Doom revision:

```text
410d96855b5df5410ff591a90efeafa889119224
```

LinuxDOOM baseline:

```text
a77dfb96cb91780ca334d0d4cfd86957558007e0
```

Public shareware IWAD:

- size: 4,196,020 bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

## Current geometry boundary

Supported v2 topology work is deliberately bounded: room extrusion, straight corridor connection and low-level Doom primitives with validation. Arbitrary free-form polygon generation, automatic obstacle-routing corridors, and arbitrary deletion/merging of legacy sectors are not yet treated as safe semantic operations.

The governing rule is simple:

> **AI proposes topology; deterministic validation + node building decides whether it is loadable.**
