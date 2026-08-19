import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { buildNavigationGraph } from './navigation_graph.js';
import { runNavigationBrowserTrial } from './navigation_browser_agent.mjs';
import { createSeededBlankMapPwad, markWorkspaceAsGenerated } from './blank_map.js';
import { startBridge } from './server.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
startBridge();

const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.join(here, 'exports');
await mkdir(exportDir, { recursive: true });

const generated = createSeededBlankMapPwad({
  map: 'E1M1',
  width: 512,
  height: 384,
  floor: 0,
  ceiling: 128,
  includeExit: false
});
const episode = new EpisodeWorkspace(generated.bytes, ['E1M1'], 'p2-seed-only-runtime');
for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
for (const baseline of episode.baselines.values()) markWorkspaceAsGenerated(baseline);
const workspace = episode.workspaces.get('E1M1');
const validation = workspace.validate();
assert.equal(validation.ok, true, JSON.stringify(validation));

const candidate = await episode.build({ filename: 'p2-seed-only-runtime.wad' });
assert.equal(candidate.maps[0].inspected.ok, true, JSON.stringify(candidate.maps[0].inspected));
const wadPath = path.join(exportDir, candidate.filename);
await writeFile(wadPath, candidate.bytes);

const report = await runNavigationBrowserTrial({
  filename: candidate.filename,
  wadPath,
  map: 'E1M1',
  graph: buildNavigationGraph(workspace),
  targetSector: 0,
  reportDir: path.join(exportDir, 'p2-blank', 'seed-only-runtime'),
  captureFrame: true,
  bootDirectToMap: true
});
assert.equal(report.startSector, 0, JSON.stringify(report));
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(Number(report.finalState.currentSector), 0);
console.error('P2.0 source-free seed-only LinuxDOOM boot passed:', JSON.stringify({
  seed: generated.seed,
  candidateBytes: candidate.bytes.length,
  finalSector: report.finalState.currentSector
}));
process.exit(0);
