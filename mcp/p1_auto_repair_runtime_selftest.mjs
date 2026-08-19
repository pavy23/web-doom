import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { buildNavigationGraph } from './navigation_graph.js';
import { diagnoseNavigation, installAutoRepair, planAutoRepairs } from './auto_repair.js';
import { applyRepairPlan } from './auto_repair_episode.js';
import { runNavigationBrowserTrial } from './navigation_browser_agent.mjs';
import { startBridge } from './server.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);
startBridge();

const NO_SIDE = 0xffff;
const ML_BLOCKING = 0x0001;
const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.join(here, 'exports');
await mkdir(exportDir, { recursive: true });
const source = await readFile(path.join(here, '..', 'doom1.wad'));

function midpoint(g, line) {
  const a = g.vertices[line.v1], b = g.vertices[line.v2];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function lineLength(g, line) {
  const a = g.vertices[line.v1], b = g.vertices[line.v2];
  return Math.hypot(b.x - a.x, b.y - a.y);
}
function frontSector(g, line) {
  if (line.right === NO_SIDE) return null;
  return g.sidedefs[line.right]?.sector ?? null;
}
function findSafeWall() {
  const base = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
  const workspace = base.workspaces.get('E1M1');
  const graph = buildNavigationGraph(workspace);
  const start = graph.things.starts.find(item => item.doomEdNum === 1 && item.sector != null);
  assert.ok(start, 'E1M1 Player 1 start must be locatable');
  const candidates = workspace.geometry.linedefs.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.left === NO_SIDE && frontSector(workspace.geometry, line) === start.sector && lineLength(workspace.geometry, line) >= 64)
    .sort((a, b) => {
      const pa = midpoint(workspace.geometry, a.line), pb = midpoint(workspace.geometry, b.line);
      return Math.hypot(pa.x - start.x, pa.y - start.y) - Math.hypot(pb.x - start.x, pb.y - start.y);
    });
  for (const candidate of candidates) {
    const probe = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
    try {
      probe.beginTransaction(`P1.4 runtime probe ${candidate.index}`);
      const result = probe.applyEdits([{ type: 'add_polygon_room', map: 'E1M1', line: candidate.index, sides: 4, depth: 80, wallTexture: 'STARTAN3' }]);
      const validation = probe.validate({ touchedOnly: true });
      const targetSector = result.results[0].result.sector;
      if (validation.ok) {
        probe.rollbackTransaction();
        return { line: candidate.index, targetSector, startSector: start.sector };
      }
      probe.rollbackTransaction();
    } catch {
      if (probe.transaction) probe.rollbackTransaction();
    }
  }
  throw new Error(`No P0-safe authored room wall found in Player 1 sector ${start.sector}`);
}

const chosen = findSafeWall();
const episode = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
episode.beginTransaction('P1.4 runtime author room');
const authored = episode.applyEdits([{ type: 'add_polygon_room', map: 'E1M1', line: chosen.line, sides: 4, depth: 80, wallTexture: 'STARTAN3' }]);
const targetSector = authored.results[0].result.sector;
assert.equal(episode.validate({ touchedOnly: true }).ok, true);
assert.equal(episode.commitTransaction().committed, true);

const workspace = episode.workspaces.get('E1M1');
workspace.geometry.linedefs[chosen.line].flags |= ML_BLOCKING;
const brokenGraph = buildNavigationGraph(workspace);
assert.equal(brokenGraph.edges.some(edge => edge.from === chosen.startSector && edge.to === targetSector && edge.passable), false);
const before = diagnoseNavigation(workspace, { targetSector });
assert.equal(before.healthy, false, JSON.stringify(before));
assert.ok(before.issues.some(row => row.code === 'BLOCKED_PORTAL_FLAG'), JSON.stringify(before));
const plan = planAutoRepairs(workspace, before);
assert.ok(plan.edits.some(edit => edit.type === 'repair_clear_blocking'), JSON.stringify(plan));
console.error('P1.4 runtime deliberately broken authored portal diagnosed:', JSON.stringify({ line: chosen.line, targetSector, issues: before.issues.map(row => row.code) }));

episode.beginTransaction('P1.4 runtime auto repair');
applyRepairPlan(episode, plan.edits);
const validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation));
assert.equal(episode.commitTransaction().committed, true);
const after = diagnoseNavigation(workspace, { targetSector });
assert.equal(after.healthy, true, JSON.stringify(after));

const candidate = await episode.build({ filename: 'p1-auto-repair-runtime.wad' });
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
  reportDir: path.join(exportDir, 'auto-repair', 'p1-auto-repair-runtime'),
  maxTicsPerEdge: 280,
  captureFrame: true
});
assert.equal(report.startSector, chosen.startSector, JSON.stringify(report));
assert.equal(report.plan?.found, true, JSON.stringify(report.plan));
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(Number(report.finalState.currentSector), targetSector);
assert.ok(report.screenshot);
console.error('P1.4 diagnose -> repair -> ZDBSP -> LinuxDOOM autonomous replay passed:', JSON.stringify({
  startSector: chosen.startSector,
  targetSector,
  portalLine: chosen.line,
  usedTics: report.edgeResults.reduce((sum, item) => sum + item.usedTics, 0),
  distanceUnits: report.telemetry?.distanceUnits
}));
process.exit(0);
