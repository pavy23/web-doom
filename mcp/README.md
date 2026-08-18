# Web DOOM MCP — v1.1 Closed-loop Authoring + Live Cheats

This directory contains the local MCP control plane for the direct LinuxDOOM WebAssembly port.

Current MCP version: **1.1.0**.

v1.1 retains the complete v1.0 authoring loop and adds two live-session capabilities:

- explicit DOOM cheat controls for debugging and navigation,
- stronger desktop-browser audio diagnostics and recovery.

Cheats and audio controls are **playtest-only**. They never enter the authoring ChangeSet and are never serialized into a PWAD.

```text
MCP-host AI
   │
   ├─ author / checkpoint / reload / evaluate
   ├─ autonomous player input
   ├─ live cheats
   └─ audio diagnostics
   │
   ▼
LinuxDOOM WebAssembly
```

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

`npm start` launches **`cheat_server.js`**, which composes all v1.0 tools plus v1.1 cheat/audio tools.

Open:

```text
http://127.0.0.1:3777/
```

Click **CLICK TO START**.

Local bridges:

```text
127.0.0.1:3777/control       bounded authoring
127.0.0.1:3778/playtest      vision / telemetry / exact-tic / agent input
127.0.0.1:3779/orchestrate   closed-loop authoring sessions
127.0.0.1:3780/cheats        live cheats + audio diagnostics
```

Generic MCP host configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/cheat_server.js"]
}
```

If the MCP host launches `cheat_server.js`, do not also run `npm start` on the same ports.

# v1.1 live cheat tools

## `doom_cheat_status`

Reads the live player state relevant to debugging:

```text
god mode
noclip
health / armor
weapons
keys
bullets / shells / cells / rockets
active power-ups
current episode / map
```

## `doom_set_god_mode`

Enable or disable the original-style `CF_GODMODE` player flag.

Example natural-language request:

```text
무적 켜줘.
```

## `doom_set_noclip`

Enable or disable the original-style `CF_NOCLIP` flag.

```text
노클립 켜줘.
```

## `doom_give_arsenal`

Gives the classic IDFA/IDKFA-style live loadout:

- 200 armor,
- all weapons,
- max ammunition,
- optionally all keys.

```text
무기, 탄약, 키 전부 줘.
```

`includeKeys=false` gives weapons/ammo/armor without the keys.

## `doom_give_keys`

Gives all available card/skull keys without changing weapons or ammo.

## `doom_set_health_armor`

Directly sets live health and armor within bounded values:

```text
health     1..200
armor      0..200
armorType  0..2
```

## `doom_give_powerup`

Uses the original DOOM power state for one of:

```text
invulnerability
berserk
invisibility
radiation
allmap
lightamp
```

## `doom_warp`

Starts another valid map through LinuxDOOM `G_InitNew()` at the current skill.

The public shareware IWAD supports:

```text
E1M1 .. E1M9
```

Example:

```text
E1M5로 이동해.
```

Warping is playtest-only but changes the current live map, so do not casually use it in the middle of an active authoring session whose goal assumes another map.

# Desktop browser audio recovery

The modern Emscripten SDL2 WebAudio context can live at `Module.SDL2.audioContext`. v1.1 explicitly checks that context as well as legacy/global locations.

The browser layer now:

1. retries `AudioContext.resume()` after CLICK TO START,
2. retries on pointer, keyboard and touch user gestures,
3. retries when the tab becomes visible again,
4. explicitly unpauses the SDL audio device/mixer,
5. adds an on-screen **AUDIO** button for a guaranteed fresh browser user gesture.

If a desktop browser is silent:

```text
1. CLICK TO START
2. click AUDIO once
3. confirm it changes to AUDIO ON
```

Then use the MCP diagnostics if necessary.

## `doom_audio_status`

Returns browser AudioContext state plus SDL/SDL_mixer state.

Useful fields include:

```text
browser context state: suspended / running
sample rate
SDL audio initialized
SDL_mixer open
mixer frequency / channels / format
```

## `doom_audio_resume`

Attempts to resume the discovered browser audio context and unpause SDL audio.

Browser autoplay policy can require a real user gesture, so if the MCP call alone cannot unlock audio, click the on-screen **AUDIO** button once.

# v1.0 closed-loop authoring retained

The complete v1 loop remains available:

```text
design goal
  ↓
bounded semantic edits
  ↓
candidate PWAD checkpoint
  ↓
reload candidate as fresh baseline
  ↓
autonomous deterministic playtest
  ↓
telemetry + final PNG
  ↓
deterministic evaluation + optional AI vision rubric
  ↓
revision or restore previous candidate
  ↓
passing candidate
  ↓
final ordinary PWAD
```

Main session tools:

- `doom_orchestrator_status`
- `doom_begin_design_session`
- `doom_run_authoring_iteration`
- `doom_review_design_iteration`
- `doom_get_design_session`
- `doom_restore_design_candidate`
- `doom_finalize_design_session`

Hard limits remain:

```text
maximum design iterations       8
maximum persistent edits/iter  12
maximum trial actions          16
maximum trial world tics      700
maximum one action            350 tics
```

Every authoring iteration produces a real local PWAD checkpoint under `mcp/exports/` before playtesting.

# Lower-level authoring and playtest tools retained

Inspection:

- `doom_get_state`
- `doom_get_enemies`
- `doom_get_sectors`
- `doom_get_linedefs`
- `doom_get_visuals`
- `doom_list_visual_assets`
- `doom_get_changeset`

Persistent authoring:

- `doom_set_sector_light` → `SECTORS`
- `doom_spawn_enemy` / `doom_remove_nearest_enemy` → `THINGS`
- `doom_set_linedef_action` → `LINEDEFS`
- `doom_set_wall_texture` → `SIDEDEFS`
- `doom_set_sector_flat` → `SECTORS`

PWAD iteration:

- `doom_export_pwad`
- `doom_list_exports`
- `doom_load_pwad`
- `doom_reload_current_map`

Observation / simulation:

- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`
- `doom_run_input`
- `doom_run_input_sequence`

Evaluation:

- `doom_run_design_trial`
- `doom_evaluate_playtest`
- `doom_get_trial_history`
- `doom_compare_trials`

Older debug helpers remain available as well, including `doom_heal`, `doom_give_ammo` and `doom_teleport`.

# Persistence boundary

Persistent authoring is still intentionally limited to existing-geometry records:

```text
THINGS
LINEDEFS
SIDEDEFS
SECTORS
```

The following topology/BSP-derived records remain unchanged:

```text
VERTEXES
SEGS
SSECTORS
NODES
REJECT
BLOCKMAP
```

Live cheats, player movement, teleport, health/ammo manipulation, power-ups, god mode, noclip and map warp are **not** PWAD authoring operations.

# Recommended separation

Use cheats for:

- manual debugging,
- quickly reaching another room/map,
- inspecting doors or materials,
- isolating combat/navigation problems.

Turn cheats off for automated difficulty evaluation. A candidate should pass its design goal under the intended normal player state, not because god mode or a full arsenal was active.
