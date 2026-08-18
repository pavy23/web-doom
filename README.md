# Web DOOM — Direct LinuxDOOM + AI Level Authoring MCP v1.1

A direct browser port of **id Software LinuxDOOM 1.10** to WebAssembly, extended with a local MCP system for bounded AI level authoring, autonomous deterministic playtesting, visual observation, explicit design-goal evaluation, candidate checkpointing, final PWAD delivery, live debugging cheats and browser-audio diagnostics.

The `/direct/` runtime starts from the original LinuxDOOM source. It does **not** use doomgeneric or Chocolate Doom as the game runtime.

## Play

- [Direct LinuxDOOM WebAssembly build](https://pavy23.github.io/web-doom/direct/)
- [Earlier doomgeneric comparison build](https://pavy23.github.io/web-doom/)

Development branch: [`direct-linuxdoom`](https://github.com/pavy23/web-doom/tree/direct-linuxdoom)

Current MCP version: **1.1.0**

## What this project became

The project started as a browser-port experiment. It is now a small **AI-native game-content authoring, playtest and evaluation pipeline**.

```text
AI design goal
      ↓
semantic inspection
      ↓
bounded authoring plan
      ↓
candidate PWAD checkpoint + reload
      ↓
autonomous ticcmd playtest
      ↓
telemetry + PNG frame
      ↓
deterministic evaluator + optional AI vision rubric
      ↓
PASS / FAIL + revision hints
      ↓
next bounded revision / restore older candidate
      ↓
final ordinary PWAD
```

v1.1 also adds a deliberately separate **live debugging layer**:

```text
god mode / noclip / arsenal / keys / power-ups / map warp
browser AudioContext + SDL_mixer diagnostics/recovery
```

Those controls are runtime-only and never enter a PWAD or authoring ChangeSet.

# v1.0 closed-loop authoring retained

Main session tools:

- `doom_orchestrator_status`
- `doom_begin_design_session`
- `doom_run_authoring_iteration`
- `doom_review_design_iteration`
- `doom_get_design_session`
- `doom_restore_design_candidate`
- `doom_finalize_design_session`

Each authoring iteration is bounded and produces a real `.wad` checkpoint before playtesting:

```text
<= 12 semantic edits
→ candidate PWAD
→ validate + reload
→ ChangeSet reset
→ <= 16 autonomous actions
→ <= 700 actual P_Ticker world tics
→ telemetry evaluation
→ final PNG
```

A session is capped at 8 iterations. A previous checkpoint can be restored before trying another revision. Normal finalization chooses a passing candidate; forcing a failing candidate requires an explicit override.

# v1.1 live cheat controls

New MCP tools:

- `doom_cheat_status`
- `doom_set_god_mode`
- `doom_set_noclip`
- `doom_give_arsenal`
- `doom_give_keys`
- `doom_set_health_armor`
- `doom_give_powerup`
- `doom_warp`

The implementation follows original LinuxDOOM player state rather than browser-keyboard emulation:

- god mode uses `CF_GODMODE`,
- noclip uses `CF_NOCLIP`,
- the full arsenal mirrors the classic IDFA/IDKFA idea: 200 armor, all weapons, max ammo, optional keys,
- power-ups use the original DOOM power state,
- map warp starts a valid map through `G_InitNew()`.

The public shareware IWAD supports `E1M1` through `E1M9` for warp testing.

Examples for an MCP-host AI:

```text
무적 켜줘.
노클립 켜줘.
무기, 탄약, 키 전부 줘.
체력 200, 아머 200으로 해줘.
인벌너러빌리티 파워업 줘.
E1M5로 워프해.
```

Use cheats for manual debugging and exploration. Disable them for difficulty/quality evaluation when the design goal assumes a normal player state.

# Desktop browser audio recovery

v1.1 strengthens audio startup for browsers where mobile audio works but desktop remains silent.

Modern Emscripten SDL2 can keep its WebAudio context at `Module.SDL2.audioContext`. The previous launcher only retried a narrower legacy/global path. v1.1 now checks the actual SDL context plus fallback locations, retries after user gestures, and explicitly unpauses the SDL audio device/mixer.

The game UI also gains an **AUDIO** button.

If desktop audio is silent:

```text
CLICK TO START
→ click AUDIO once
→ confirm AUDIO ON
```

New diagnostics:

- `doom_audio_status`
- `doom_audio_resume`

`doom_audio_status` reports browser AudioContext state plus SDL/SDL_mixer state. Browser autoplay policy can still require a real click, so the on-screen AUDIO button is the final explicit user-gesture fallback.

# Authoring surface

Inspection:

- `doom_get_state`
- `doom_get_enemies`
- `doom_get_sectors`
- `doom_get_linedefs`
- `doom_get_visuals`
- `doom_list_visual_assets`
- `doom_get_changeset`

Persistent authoring:

- actor spawn/remove → `THINGS`
- door/trigger special + tag → `LINEDEFS`
- wall textures → `SIDEDEFS`
- sector lighting → `SECTORS`
- floor/ceiling flats → `SECTORS`

PWAD iteration:

- `doom_export_pwad`
- `doom_list_exports`
- `doom_load_pwad`
- `doom_reload_current_map`

# Playtest observation, agency and evaluation

Observation:

- `doom_pause_playtest`
- `doom_resume_playtest`
- `doom_step_tics`
- `doom_get_playtest_telemetry`
- `doom_reset_playtest_metrics`
- `doom_capture_frame`

Autonomous input:

- `doom_agent_input_status`
- `doom_cancel_agent_input`
- `doom_run_input`
- `doom_run_input_sequence`

Evaluation:

- `doom_run_design_trial`
- `doom_evaluate_playtest`
- `doom_get_trial_history`
- `doom_compare_trials`

AI movement is applied through LinuxDOOM's real console-player `ticcmd_t` path and is consumed by normal `P_Ticker()` gameplay simulation.

# Architecture

```text
LinuxDOOM 1.10 + browser/WASM adapters
                │
                ▼
              Browser
   ┌────────────┼─────────────┬─────────────┐
   │            │             │             │
:3777/control :3778/playtest :3779/orchestrate :3780/cheats
   │            │             │             │
   └────────────┴──────┬──────┴─────────────┘
                       ▼
              mcp/cheat_server.js
                       │
              stdio MCP host / AI
```

`cheat_server.js` composes all v1.0 authoring/playtest/orchestration tools and adds the v1.1 cheat/audio surface.

The public GitHub Pages game does not connect to localhost during ordinary public play. Local bridges activate only in the local MCP workflow.

# Quick start

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

Click **CLICK TO START**. If desktop audio remains silent, click **AUDIO** once.

Generic MCP client configuration:

```json
{
  "command": "node",
  "args": ["C:/absolute/path/to/web-doom/mcp/cheat_server.js"]
}
```

Detailed guide: [`mcp/README.md`](https://github.com/pavy23/web-doom/blob/direct-linuxdoom/mcp/README.md)

# Persistence boundary

Persistent authored records remain limited to existing-geometry data:

```text
THINGS
LINEDEFS
SIDEDEFS
SECTORS
```

Topology/BSP-derived data remains unchanged:

```text
VERTEXES
SEGS
SSECTORS
NODES
REJECT
BLOCKMAP
```

God mode, noclip, arsenal/ammo/keys, health/armor changes, power-ups, map warp, player movement and audio state are live-session controls only.

# Audio path

Sound effects use direct DMX type-3 decoding through SDL2_mixer.

Music uses a Vanilla/DMX-compatible OPL register path with IWAD `GENMIDI` instrumentation and Nuked OPL3 v1.8 running in OPL2-compatible mode. The OPL/MIDI subsystem is imported from pinned Chocolate Doom revision `410d96855b5df5410ff591a90efeafa889119224`; Chocolate Doom is not the game runtime.

LinuxDOOM baseline:

`a77dfb96cb91780ca334d0d4cfd86957558007e0`

Public shareware IWAD:

- size: `4,196,020` bytes
- MD5: `5f4eb849b1af12887dec04a2a12e5e62`

Commercial DOOM / DOOM II IWADs are not distributed by this repository.
