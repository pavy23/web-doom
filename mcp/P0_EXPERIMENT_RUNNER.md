# P0 Automated Episode Experiment Runner

`npm start` now launches `p0_experiment_server.js`, which composes the existing P0 authoring server and adds an automated multi-map regression runner.

## One-call MCP tool

`doom_run_episode_experiment`

Default behavior:

1. uses E1M1 through E1M8;
2. builds a verified episode PWAD from the configured source WAD, unless `candidateFilename` points at an already exported multi-map PWAD;
3. rebuilds map nodes through the pinned/hash-verified ZDBSP path when a new candidate is built;
4. launches a dedicated headless Chromium;
5. stages the candidate through the structural geometry cold-boot path;
6. starts LinuxDOOM and explicitly warps to each requested map;
7. pauses world simulation and runs exact-tic deterministic smoke actions or caller-supplied action plans;
8. captures final PNG evidence and telemetry per map;
9. writes a PASS/FAIL JSON report under `mcp/exports/experiments/<experiment-id>/`.

The experiment browser uses direct browser APIs for the test sequence. It does not depend on an operator clicking `START CANDIDATE`.

## Useful modes

### Regression-test an already built episode

Pass `candidateFilename` with the filename produced by `doom_build_episode`. The runner verifies that every requested map marker is present, cold-boots the existing candidate, and tests it without rebuilding.

### Build and test a custom edit batch

Pass `edits` using the same multi-map structural edit objects accepted by P0 transactions. The runner creates an isolated episode workspace, applies the entire edit batch atomically, validates it, builds the candidate, and then launches the browser test.

### Pipeline smoke edit across every map

Set `autoEditProfile` to `safe-height-nudge`. The runner selects one ordinary untagged sector per requested map and raises its ceiling by 8 map units. This profile exists to prove that every map in the map set is actually mutated, validated, rebuilt and runtime-tested; it is not intended as a level-design policy.

### Deterministic actions per map

Use `actionsByMap`, for example:

```json
{
  "E1M1": [
    { "forward": 0.7, "tics": 35 },
    { "turn": 0.4, "tics": 18 }
  ],
  "E1M2": [
    { "forward": 0.5, "attack": true, "tics": 50 }
  ]
}
```

Each action is bounded to 350 tics and each map plan to 700 total tics. If no plan is supplied, the runner executes a no-input exact-tic smoke window.

### Per-map expectations

`expectationsByMap` currently supports:

- `maxDeaths`
- `minHealth`
- `minDistanceUnits`
- `minVisitedSectors`

The default smoke expectation is zero deaths, health >= 1, and at least one visited sector.

## Evidence

Each experiment directory contains:

- `config.json`
- `report.json`
- `<MAP>.png` for every captured map

Use `doom_get_episode_experiment_report` with the experiment id to retrieve the full stored report.

## Local setup

Install dependencies normally:

```bash
npm install
```

The runner first tries Playwright-managed Chromium, then falls back to an installed Chrome channel. To guarantee the managed browser is present:

```bash
npm run prepare-experiment
```

## CI

`p0_experiment_selftest.mjs` builds an E1M1-E1M8 episode candidate, cold-boots it in Chromium, warps through all eight maps, advances exact world tics, captures evidence, and requires every map to pass. This runs in `.github/workflows/p0-episode.yml` after the existing P0 topology/build and five-bridge browser tests.
