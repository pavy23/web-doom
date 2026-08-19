import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { diagnoseNavigation, installAutoRepair, planAutoRepairs } from './auto_repair.js';
import { applyRepairPlan } from './auto_repair_episode.js';
import { buildNavigationGraph } from './navigation_graph.js';
import { runNavigationBrowserTrial } from './navigation_browser_agent.mjs';
import { createSeededBlankMapPwad, markWorkspaceAsGenerated } from './blank_map.js';
import { startBridge } from './server.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);
startBridge();

const ML_BLOCKING = 0x0001;
const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.join(here, 'exports');
await mkdir(exportDir, { recursive: true });

const generated = createSeededBlankMapPwad({
  map: 'E1M1',
  width: 512,
  height: 384,
  floor: 0,
  ceiling: 128,
  exitWall: 'east'
});
const episode = new EpisodeWorkspace(generated.bytes, ['E1M1'], 'p2-source-free-runtime');
for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
for (const baseline of episode.baselines.values()) markWorkspaceAsGenerated(baseline);

const workspace = episode.workspaces.get('E1M1');
assert.equal(workspace.validate().ok, true, JSON.stringify(workspace.validate()));

// Extend the map entirely from generated geometry through the existing P1.2 layer.
episode.beginTransaction('P2 runtime semantic extension');
const edit = episode.applyEdits([{
  type: 'add_polygon_room',
  map: 'E1M1',
  line: 0,
  sides: 4,
  depth: 160,
  wallTexture: 'STARTAN3',
  light: 160
}]);
const authored = edit.results[0].result;
const targetSector = authored.sector;
assert.equal(episode.validate({ touchedOnly: true }).ok, true);
assert.equal(episode.commitTransaction().committed, true);

// Prove P1.4 can repair generated geometry without legacy opt-in.
workspace.geometry.linedefs[authored.portalLine].flags |= ML_BLOCKING;
const broken = diagnoseNavigation(workspace, { targetSector });
assert.equal(broken.healthy, false, JSON.stringify(broken));
assert.ok(broken.issues.some(issue => issue.code === 'BLOCKED_PORTAL_FLAG'), JSON.stringify(broken.issues));
const repair = planAutoRepairs(workspace, broken, {
  targetSector,
  allowLegacyGeometry: false,
  allowThingRepair: true,
  maxEdits: 4
});
assert.ok(repair.edits.some(item => item.type === 'repair_clear_blocking'), JSON.stringify(repair));

episode.beginTransaction('P2 runtime repair generated portal');
applyRepairPlan(episode, repair.edits);
const repairedValidation = episode.validate({ touchedOnly: true });
assert.equal(repairedValidation.ok, true, JSON.stringify(repairedValidation));
assert.equal(episode.commitTransaction().committed, true);
const repaired = diagnoseNavigation(workspace, { targetSector });
assert.equal(repaired.healthy, true, JSON.stringify(repaired));

const candidate = await episode.build({ filename: 'p2-blank-map-runtime.wad' });
assert.equal(candidate.maps[0].inspected.ok, true, JSON.stringify(candidate.maps[0].inspected));
const wadPath = path.join(exportDir, candidate.filename);
await writeFile(wadPath, candidate.bytes);

const graph = buildNavigationGraph(workspace);
const report = await runNavigationBrowserTrial({
  filename: candidate.filename,
  wadPath,
  map: 'E1M1',
  graph,
  targetSector,
  reportDir: path.join(exportDir, 'p2-blank', 'runtime-selftest'),
  maxTicsPerEdge: 280,
  captureFrame: true
});
assert.equal(report.startSector, 0, JSON.stringify(report));
assert.equal(report.plan?.found, true, JSON.stringify(report.plan));
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(Number(report.finalState.currentSector), targetSector);
assert.ok(report.screenshot);

console.error('P2.0 blank map -> semantic authoring -> auto-repair -> LinuxDOOM standard-warp autonomous replay passed:', JSON.stringify({
  sourceLegacyMap: false,
  seedCounts: generated.seed.counts,
  targetSector,
  portalLine: authored.portalLine,
  repairTypes: repair.edits.map(item => item.type),
  usedTics: report.edgeResults.reduce((sum, item) => sum + item.usedTics, 0),
  distanceUnits: report.telemetry?.distanceUnits
}));
process.exit(0);
