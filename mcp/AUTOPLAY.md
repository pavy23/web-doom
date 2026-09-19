# Autoplay — autonomous stage clearing

`autoplay_stage_runner.mjs` drives the original LinuxDOOM runtime through a
complete single-player level: plan a route from the Player 1 start to the exit,
follow it with the exact-tic browser controller, press the exit switch and
confirm that the engine left `GS_LEVEL`.

This is **layer 1** of the autoplay stack. It is fully deterministic and needs
no AI service. Layer 2 (a TypeSafe System One tactical policy) plugs into the
`decide` hook described below.

## Run

From `mcp/`:

```bash
npm install
npm run autoplay:e1m1          # 3 god-mode runs, checks tic-for-tic determinism
npm run autoplay:e1m1:live     # 1 run without god mode (monsters can kill you)

node autoplay_stage_runner.mjs --map E1M1 --runs 3 [--no-god] [--max-edge-tics 280] [--report-dir DIR]
```

The runner starts the local game bridge itself (`DOOM_MCP_PORT`, default 3777),
serves the runtime from `direct/` or `mcp/.cache/direct-runtime`, and exits when
the trial is written.

If the host's Chromium does not match the pinned Playwright revision, point the
launcher at an executable:

```bash
DOOM_MCP_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium npm run autoplay:e1m1
```

## Pipeline

```text
doom1.wad ── EpisodeWorkspace(E1M1) ── pinned ZDBSP rebuild ── autoplay-e1m1.wad
                     │
          buildNavigationGraph ── findExitProgression(start sector)
                     │                       │
                     │              sector route + exit line (+ keys)
                     ▼                       ▼
  Chromium ── coldBoot(PWAD) ── warp E1M1 ── pause world
                     │
        for each route edge: navigateEdge()  (exact-tic ticcmd steps)
                     │
        approachAndUseExit()  → USE on the exit line
                     │
        getState().ready === false && gameState !== 0   → CLEARED
```

Every step (state before, command, world tic, door opening, health) is
appended to `<reportDir>/steps.jsonl`; `report.json` holds the plan, per-edge
results, the final telemetry sample and a summary with clear rate and a
`deterministic` flag (all cleared runs used the same number of world tics).

## Route following details

`navigateEdge` in `navigation_browser_agent.mjs` gained three options:

| Option | Purpose |
|---|---|
| `acceptSectors` | A set of later route sectors. Thin sectors (door frames, step lips) can be crossed without the player centre ever registering inside them, so landing in any later sector counts as progress and the runner skips ahead. |
| `useNearPortal` / `doorSector` | A closed door directly behind a portal blocks the player radius before the centre can enter the door frame. When the next edge is a door, USE is pressed at this portal. The door sector's live ceiling/floor opening is sampled each step. |
| `decide`, `onStep` | Policy hook and step observer (see below). |

USE is pressed only when the tracked door is closed or closing. Vanilla
`EV_VerticalDoor` toggles a moving door, so pressing USE while it opens would
close it again. This was the cause of the first E1M1 failure at the door
before the exit corridor.

## Policy hook for layer 2

```js
await runStageClearTrial({
  map: 'E1M1',
  godMode: false,
  decide: async ({ state, edge, exit, proposal, usedTics }) => {
    // state: DoomControl.getState() (player, ammo, visible enemies with
    //        distance / relativeAngle / lineOfSight ...)
    // proposal: the deterministic command for this step
    // return a full command { forward, strafe, turn, attack, use, tics, source }
    // or a falsy value to keep the proposal.
    return null;
  }
});
```

The world is paused between steps, so the latency of an external judgment
service never affects gameplay and every run stays replayable from
`steps.jsonl`. Set `source` on a returned command (for example `'jev'`) to have
it recorded in the step log.

## Reference results

Shareware E1M1, god mode, this environment:

```text
route     20 transitions (5 doors, 1 lift), 0 keys
exit      line 330, special 11 (switch)
result    CLEARED, 1296 world tics (~37 s game time), 488 steps
```
