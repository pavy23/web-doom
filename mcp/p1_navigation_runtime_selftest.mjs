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
import { runNavigationBrowserTrial } from './navigation_browser_agent.mjs';
import { startBridge } from './server.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
startBridge();

const NO_SIDE = 0xffff;
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

const baseline = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
const baselineWorkspace = baseline.workspaces.get('E1M1');
const baselineGraph = buildNavigationGraph(baselineWorkspace);
const playerStart = baselineGraph.things.starts.find(start => start.doomEdNum === 1 && start.sector != null);
assert.ok(playerStart, 'E1M1 Player 1 start must map to a sector');

const candidates = baselineWorkspace.geometry.linedefs.map((line, index) => ({ line, index }))
  .filter(({ line }) => line.left === NO_SIDE && frontSector(baselineWorkspace.geometry, line) === playerStart.sector && lineLength(baselineWorkspace.geometry, line) >= 64)
  .sort((a, b) => {
    const pa = midpoint(baselineWorkspace.geometry, a.line), pb = midpoint(baselineWorkspace.geometry, b.line);
    return Math.hypot(pa.x - playerStart.x, pa.y - playerStart.y) - Math.hypot(pb.x - playerStart.x, pb.y - playerStart.y);
  });

let chosen = null;
for (const { index } of candidates) {
  const probe = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
  try {
    probe.beginTransaction(`probe navigation room line ${index}`);
    const result = probe.applyEdits([{ type: 'add_polygon_room', map: 'E1M1', line: index, sides: 4, depth: 80, wallTexture: 'STARTAN3' }]);
    const validation = probe.validate({ touchedOnly: true });
    if (validation.ok) {
      chosen = { line: index, targetSector: result.results[0].result.sector };
      probe.rollbackTransaction();
      break;
    }
    probe.rollbackTransaction();
  } catch {
    if (probe.transaction) probe.rollbackTransaction();
  }
}
assert.ok(chosen, `No P0-safe one-sided wall found in Player 1 start sector ${playerStart.sector}`);

const episode = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
episode.beginTransaction('P1.3 authored-space reachability trial');
const applied = episode.applyEdits([{
  type: 'add_polygon_room', map: 'E1M1', line: chosen.line, sides: 4, depth: 80, wallTexture: 'STARTAN3'
}]);
const targetSector = applied.results[0].result.sector;
assert.equal(targetSector, chosen.targetSector);
const validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation));
assert.equal(episode.commitTransaction().committed, true);
const graph = buildNavigationGraph(episode.workspaces.get('E1M1'));
const portal = graph.edges.find(edge => edge.from === playerStart.sector && edge.to === targetSector && edge.passable);
assert.ok(portal, `Authored sector ${targetSector} should be adjacent/passable from Player 1 sector ${playerStart.sector}`);

const candidate = await episode.build({ filename: 'p1-navigation-runtime.wad' });
assert.equal(candidate.maps[0].inspected.ok, true, JSON.stringify(candidate.maps[0].inspected));
const wadPath = path.join(exportDir, candidate.filename);
await writeFile(wadPath, candidate.bytes);

console.error('P1.3 navigation runtime target:', JSON.stringify({ startSector: playerStart.sector, targetSector, line: chosen.line, portal: portal.line }));
const report = await runNavigationBrowserTrial({
  filename: candidate.filename,
  wadPath,
  map: 'E1M1',
  graph,
  targetSector,
  reportDir: path.join(exportDir, 'navigation', 'p1-navigation-runtime'),
  maxTicsPerEdge: 280,
  captureFrame: true
});
assert.equal(report.startSector, playerStart.sector, JSON.stringify({ static: playerStart, runtime: report.startSector }));
assert.equal(report.plan?.found, true, JSON.stringify(report.plan));
assert.equal(report.plan.edges.length, 1, JSON.stringify(report.plan));
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(Number(report.finalState.currentSector), targetSector);
assert.ok(report.screenshot);
console.error('P1.3 authored polygon room autonomous exact-tic navigation passed:', JSON.stringify({
  startSector: report.startSector,
  targetSector,
  usedTics: report.edgeResults.reduce((sum, item) => sum + item.usedTics, 0),
  distanceUnits: report.telemetry?.distanceUnits
}));
process.exit(0);
