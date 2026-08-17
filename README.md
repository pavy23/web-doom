# Web DOOM — Direct LinuxDOOM Browser Port + AI Authoring MCP

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, plus a local **MCP authoring plane** that lets AI inspect the live simulation, edit selected level content, playtest it immediately, export the result as a real PWAD, reload that PWAD as the next baseline, and continue iterating.

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
   ├── inspect player / enemies / sectors / linedefs
   ├── edit lighting
   ├── spawn / remove actors
   ├── edit existing door / trigger behavior
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

Current MCP version: **0.5.0**.

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
- `doom_get_changeset`

`doom_get_linedefs` exposes existing line index, special/action, tag, flags, two-sided state, front/back sector, endpoints and player distance. It can filter specifically for recognized Vanilla door specials.

### Persistent authoring

- `doom_set_sector_light` → `SECTORS`
- `doom_spawn_enemy` → `THINGS`
- `doom_remove_nearest_enemy` → `THINGS`
- `doom_set_linedef_action` → `LINEDEFS`
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

## v0.5 — door / linedef authoring

DOOM stores linedef editing data separately from BSP-derived geometry. The persistent `maplinedef_t` record contains vertices/sides plus semantic fields such as `flags`, `special` and `tag`.

v0.5 deliberately changes only **existing linedef `special` and `tag` values**. It does not move vertices or modify topology, so `SEGS`, `SSECTORS`, `NODES` and `BLOCKMAP` do not need to be regenerated for these edits.

Supported allow-listed door presets include:

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

Remote switch/button actions normally require a meaningful sector tag. Manual door actions generally operate on the adjacent back sector.

`doom_activate_linedef` invokes the selected line through the original LinuxDOOM `P_UseSpecialLine()` path for immediate behavior testing. The activation itself is temporary; the persistent definition is changed with `doom_set_linedef_action`.

## ChangeSet → PWAD

The current exporter writes the complete Vanilla current-map lump set:

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

sector light
  → SECTORS
```

All other current-map lumps are copied unchanged.

The engine first creates the PWAD in Emscripten FS; browser JavaScript transfers it over the localhost WebSocket and the Node MCP server stores it under:

```text
mcp/exports/
```

or `DOOM_MCP_EXPORT_DIR`.

## Closed authoring loop

```text
inspect
 ↓
edit actors / lighting / door rules
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
Inspect the nearby door-related linedefs.
Find the one controlling the next room and explain its current special/tag.
Change it into a reusable door-open button targeting the same sector.
Darken the room behind it to light 32.
Remove the nearest zombieman and add two imps farther inside.
Activate the door now so I can test it.

[playtest]

Show me the ChangeSet.
Export everything as horror_e1m1_v2.wad.
Reload that file as the new baseline.
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
- [`direct-port/doom_reload.c`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/doom_reload.c)
- [`direct-port/authoring_linedef_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/authoring_linedef_bridge.js)
- [`direct-port/authoring_reload_bridge.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/authoring_reload_bridge.js)
- [`direct-port/patch_control_linedefs.py`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/patch_control_linedefs.py)
- [`direct-port/Makefile.web`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/direct-port/Makefile.web)
- [`mcp/server.js`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/server.js)
- [`.github/workflows/direct-port.yml`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/.github/workflows/direct-port.yml)

Published build provenance:

[`direct/SOURCE.txt`](https://github.com/pavy23/web-doom/blob/main/direct/SOURCE.txt)

## Current limits

The project still intentionally avoids pretending that arbitrary geometry edits are safe:

- sector lighting ✅
- actor spawn/remove ✅
- existing linedef special/tag ✅
- door/trigger activation playtest ✅
- PWAD export/reload ✅
- floor/ceiling geometry editing ❌
- vertex/sector topology editing ❌
- sidedef texture authoring ❌
- BSP/node rebuild ❌
- full new-map generation ❌

A later geometry-authoring milestone should use an explicit node-builder/blockmap pipeline rather than mutating runtime topology and hoping the old BSP remains valid.

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
