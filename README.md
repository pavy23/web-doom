# Web DOOM — Direct LinuxDOOM Browser Port + AI Authoring MCP

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, plus a local **MCP authoring plane** that lets AI inspect the live simulation, edit selected level content, playtest immediately, export a real PWAD, reload that PWAD as the next baseline, and continue iterating.

The `/direct/` build starts from the original LinuxDOOM source and replaces the browser-facing platform boundary. It does **not** use doomgeneric or Chocolate Doom as the game runtime.

## Play

[▶ **Direct LinuxDOOM WebAssembly build**](https://pavy23.github.io/web-doom/direct/)

Legacy comparison build:

[▶ Earlier doomgeneric-based build](https://pavy23.github.io/web-doom/)

## Current direction

This project began as a browser-port experiment. It is now an **AI-native DOOM level-authoring sandbox**.

```text
User / AI
   ↓
MCP semantic tools
   ↓
Live LinuxDOOM
   ├── inspect player / enemies / sectors / linedefs / materials
   ├── edit lighting
   ├── spawn / remove actors
   ├── edit existing door / trigger behavior
   ├── edit existing wall textures
   ├── edit sector floor / ceiling flats
   └── playtest immediately
   ↓
Authoring ChangeSet
   ↓
PWAD export
   ↓
local .wad artifact
   ↓
PWAD reload
   ↓
LinuxDOOM native map rebuild
   ↓
fresh ChangeSet
   ↓
next AI iteration
```

The roles are deliberately separate:

- **MCP** = AI-facing authoring/control interface
- **PWAD** = persistent playable level artifact
- **LinuxDOOM** = gameplay runtime and validator

Current MCP version: **0.6.0**.

## Architecture

```text
id Software LinuxDOOM 1.10
          │
          ├── original gameplay / renderer / WAD / game state
          ├── browser i_video / i_system / i_sound / i_net
          ├── Vanilla-DMX-compatible OPL music + Nuked OPL
          ├── doom_control.c
          │      ├── live state
          │      ├── actor / sector authoring
          │      ├── ChangeSet core
          │      └── PWAD writer
          ├── doom_linedefs.c
          │      ├── linedef / door inspection
          │      ├── safe special/tag presets
          │      ├── P_UseSpecialLine() playtest
          │      └── LINEDEFS patching
          ├── doom_visuals.c
          │      ├── sector / sidedef material inspection
          │      ├── valid texture / flat discovery
          │      ├── live visual mutation
          │      └── SIDEDEFS / SECTORS patching
          └── doom_reload.c
                 ├── PWAD validation
                 ├── lumpcache growth
                 ├── W_AddFile()
                 └── G_InitNew() map rebuild
                    │
                    ↓
           Emscripten + SDL2 + SDL2_mixer
                    │
                    ↓
                 WebAssembly
                    │
                    ↓
                  Browser
                    │
             localhost WebSocket
                    │
                    ↓
              mcp/server.js
                    │
          local exports/ + stdio MCP
                    │
                    ↓
       Claude / Cursor / Codex / Inspector
```

## MCP quick start

The authoring source lives on the [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom) branch.

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

Click **CLICK TO START**. When the local bridge attaches, the top bar shows **MCP CONNECTED**.

For an MCP host, configure `mcp/server.js` as a local stdio MCP server instead of launching a second server on the same port.

Detailed guide:

[**MCP authoring guide**](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/README.md)

## Current MCP tools

### Inspection

- `doom_bridge_status`
- `doom_get_state`
- `doom_get_enemies`
- `doom_get_sectors`
- `doom_get_linedefs`
- `doom_get_visuals`
- `doom_list_visual_assets`
- `doom_get_changeset`

### Persistent authoring

- `doom_set_sector_light` → `SECTORS`
- `doom_spawn_enemy` → `THINGS`
- `doom_remove_nearest_enemy` → `THINGS`
- `doom_set_linedef_action` → `LINEDEFS`
- `doom_set_wall_texture` → `SIDEDEFS`
- `doom_set_sector_flat` → `SECTORS`
- `doom_export_pwad`
- `doom_list_exports`
- `doom_load_pwad`
- `doom_reload_current_map`

### Playtest/debug only

- `doom_activate_linedef`
- `doom_heal`
- `doom_give_ammo`
- `doom_teleport`

These affect the current simulation but are not automatically serialized as content.

## v0.6 — visual authoring

v0.6 is intended to be the last major low-level map-edit expansion before the project moves to **AI playtest / vision**.

The AI can now inspect nearby sector/sidedef materials and modify existing visual assignments while leaving geometry untouched.

### Wall textures

`doom_get_visuals` reports nearby linedef front/back sides with:

```text
line
side
sideIndex
sector
top
middle
bottom
distance
```

`doom_set_wall_texture` changes one existing `top`, `middle`, or `bottom` wall texture.

The requested name is validated by original LinuxDOOM `R_CheckTextureNumForName()` before runtime state changes. This prevents the authoring agent from inventing a nonexistent wall asset.

### Floor / ceiling flats

`doom_get_visuals` also reports sector `floorFlat` and `ceilingFlat` names.

`doom_set_sector_flat` replaces an existing sector floor or ceiling flat only when that name resolves inside the currently loaded DOOM flat namespace.

### Asset discovery

`doom_list_visual_assets` exposes actual loaded wall/flat names, with optional `wall`, `flat`, and text filters.

The intended AI behavior is:

```text
inspect current materials
 ↓
list valid candidate assets
 ↓
select from real IWAD assets
 ↓
apply live edit
 ↓
playtest
```

not to fabricate texture names from natural language.

## Door / linedef authoring

v0.5 added safe persistent editing of existing linedef `special` and `tag` fields without moving vertices or changing topology.

Supported allow-listed door presets include normal/manual, switch/button and blazing open/close/raise variants.

`doom_activate_linedef` invokes the selected line through original `P_UseSpecialLine()` for immediate behavior testing. The activation itself remains temporary; the persistent definition is changed through `doom_set_linedef_action`.

## ChangeSet → PWAD

The exporter writes the complete Vanilla current-map lump set:

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

Current persistent patches:

```text
actor spawn/remove
  → THINGS

linedef special/tag
  → LINEDEFS

wall top/middle/bottom texture
  → SIDEDEFS

sector light
  → SECTORS

sector floor/ceiling flat
  → SECTORS
```

The topology/BSP-derived lumps remain unchanged:

```text
VERTEXES
SEGS
SSECTORS
NODES
REJECT
BLOCKMAP
```

That boundary is deliberate. v0.6 is **semantic/material authoring over existing geometry**, not a general geometry editor.

The engine first creates the PWAD in Emscripten FS; browser JavaScript transfers it over the localhost WebSocket and the Node MCP server stores it under:

```text
mcp/exports/
```

or `DOOM_MCP_EXPORT_DIR`.

## Closed authoring loop

```text
inspect
 ↓
edit actors / lighting / door rules / materials
 ↓
playtest
 ↓
doom_get_changeset
 ↓
doom_export_pwad v1.wad
 ↓
doom_load_pwad v1.wad
 ↓
Node + C validation
 ↓
W_AddFile()
 ↓
G_InitNew() → P_SetupLevel()
 ↓
v1 becomes baseline
 ↓
all ChangeSets reset
 ↓
continue to v2
```

LinuxDOOM allows duplicate lump names and searches backward, so a later-loaded PWAD naturally overrides earlier IWAD/PWAD data.

A historical runtime detail required an adapter: LinuxDOOM allocates `lumpcache` at startup, while runtime `W_AddFile()` can enlarge the lump directory. `doom_reload.c` therefore validates the new lump count and grows `lumpcache` before appending the PWAD.

Runtime imports are capped per browser session because the original WAD architecture retains appended file handles/directories rather than providing a modern unload operation.

## Example AI authoring session

```text
Inspect the current room, including nearby doors and visual materials.
List darker wall textures and floor flats that actually exist in this IWAD.

Make this room feel more industrial and threatening:
- set light around 40
- replace two nearby wall textures with darker valid alternatives
- use a darker floor flat
- add two imps deeper in the room
- make the exit door a reusable button-open door

Let me play it.
Show me the full ChangeSet.
Export everything as horror_e1m1_v4.wad.
Reload that file as the new baseline and verify the materials survived.
```

## Audio

### Sound effects

```text
DOOM DS* DMX type-3 lump
   ↓
direct parser
   ↓
original 8-bit PCM + pitch/volume/stereo
   ↓
SDL2_mixer
   ↓
browser audio
```

### Music

```text
DOOM MUS + IWAD GENMIDI
   ↓
Vanilla / DMX-compatible OPL behavior
   ↓
OPL register writes
   ↓
Nuked OPL3 v1.8
(OPL2-compatible 9-voice mode)
   ↓
SDL2_mixer post-mix
   ↓
browser audio
```

The project imports only the needed OPL/MIDI subsystem from pinned Chocolate Doom revision [`410d96855b5df5410ff591a90efeafa889119224`](https://github.com/chocolate-doom/chocolate-doom/commit/410d96855b5df5410ff591a90efeafa889119224). Chocolate Doom is **not** the game runtime.

LinuxDOOM baseline: [`a77dfb96cb91780ca334d0d4cfd86957558007e0`](https://github.com/id-Software/DOOM/commit/a77dfb96cb91780ca334d0d4cfd86957558007e0)

## Key source files

- [`direct-port/doom_control.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_control.c)
- [`direct-port/doom_linedefs.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_linedefs.c)
- [`direct-port/doom_visuals.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_visuals.c)
- [`direct-port/doom_reload.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_reload.c)
- [`direct-port/authoring_linedef_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/authoring_linedef_bridge.js)
- [`direct-port/authoring_visual_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/authoring_visual_bridge.js)
- [`direct-port/authoring_reload_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/authoring_reload_bridge.js)
- [`direct-port/patch_control_linedefs.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/patch_control_linedefs.py)
- [`direct-port/patch_control_visuals.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/patch_control_visuals.py)
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web)
- [`mcp/server.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/server.js)
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml)

Published build provenance:

[`direct/SOURCE.txt`](https://github.com/pavy23/web-doom/blob/main/direct/SOURCE.txt)

## Current limits

- sector lighting ✅
- actor spawn/remove ✅
- existing linedef special/tag ✅
- door/trigger activation playtest ✅
- wall texture assignment ✅
- floor/ceiling flat assignment ✅
- PWAD export/reload ✅
- floor/ceiling height geometry editing ❌
- vertex/sector topology editing ❌
- adding new custom texture graphics ❌
- BSP/node rebuild ❌
- full new-map generation ❌

A future geometry-authoring milestone should use an explicit node-builder/blockmap pipeline rather than mutating runtime topology and hoping the old BSP remains valid.

## Next milestone — AI Playtest / Vision

The low-level authoring surface is now intentionally broad enough. The next direction is to let the AI **observe and evaluate its own work** instead of adding more editing knobs.

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
revision
   ↓
next PWAD
```

Likely next capabilities: screenshot/frame capture, pause/resume, exact tic stepping, bounded input injection and playtest telemetry.

## Shareware data

The public demo uses the redistributable DOOM shareware IWAD fetched during CI from SDL's long-standing archive.

Verification:

- size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`
- `GENMIDI`: `#OPL_II#`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.

## License / attribution

The game engine is based on the [id Software DOOM source release](https://github.com/id-Software/DOOM). The OPL/MIDI compatibility subsystem imported at build time is derived from the pinned [Chocolate Doom](https://github.com/chocolate-doom/chocolate-doom) revision, including Nuked OPL integration. SDL2, SDL2_mixer and the official Model Context Protocol TypeScript SDK retain their respective licenses/notices.

The DOOM engine/source license is separate from commercial game data; this repository does not distribute commercial IWADs.
