import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';
import { extractMapPwad } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { buildNavigationGraph, findExitProgression, findSectorPath, locatePointSector, reachableSectors } from './navigation_graph.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);

const NO_SIDE = 0xffff;
function syntheticWorkspace() {
  const vertices = [
    { x: 0, y: 0 }, { x: 0, y: 128 }, { x: 128, y: 128 }, { x: 128, y: 0 },
    { x: 256, y: 128 }, { x: 256, y: 0 }, { x: 384, y: 128 }, { x: 384, y: 0 }
  ];
  const sectors = [0, 1, 2].map(() => ({ floor: 0, ceiling: 128, light: 160, special: 0, tag: 0 }));
  const sidedefs = [];
  const side = sector => sidedefs.push({ sector }) - 1;
  const lines = [];
  const one = (v1, v2, sector, special = 0) => lines.push({ v1, v2, flags: 1, special, tag: 0, right: side(sector), left: NO_SIDE });
  const two = (v1, v2, rightSector, leftSector, special = 0, flags = 4) => lines.push({ v1, v2, flags, special, tag: 0, right: side(rightSector), left: side(leftSector) });

  one(0, 1, 0); one(1, 2, 0); two(2, 3, 0, 1); one(3, 0, 0);
  one(2, 4, 1); two(4, 5, 1, 2, 26); one(5, 3, 1);
  one(4, 6, 2); one(6, 7, 2, 11); one(7, 5, 2);

  const things = [
    { index: 0, doomEdNum: 1, x: 64, y: 64, angle: 0, flags: 7 },
    { index: 1, doomEdNum: 5, x: 192, y: 64, angle: 0, flags: 7 }
  ];
  return {
    mapName: 'E1M1',
    geometry: { vertices, linedefs: lines, sidedefs, sectors, things },
    listThings() { return things; }
  };
}

const synthetic = syntheticWorkspace();
assert.equal(locatePointSector(synthetic, { x: 64, y: 64 }), 0);
assert.equal(locatePointSector(synthetic, { x: 192, y: 64 }), 1);
assert.equal(locatePointSector(synthetic, { x: 320, y: 64 }), 2);
const graph = buildNavigationGraph(synthetic);
assert.equal(graph.summary.sectors, 3);
assert.equal(graph.summary.keys, 1);
assert.equal(graph.summary.exits, 1);
const door = graph.edges.find(edge => edge.from === 1 && edge.to === 2);
assert.equal(door.kind, 'door');
assert.equal(door.requiredKey, 'blue');
assert.equal(door.action, 'use');
assert.equal(findSectorPath(graph, 0, 2).found, false);
const keyed = findSectorPath(graph, 0, 2, { keys: ['blue'] });
assert.equal(keyed.found, true);
assert.deepEqual(keyed.sectors, [0, 1, 2]);
assert.deepEqual(reachableSectors(graph, 0), [0, 1]);
assert.deepEqual(reachableSectors(graph, 0, { keys: ['blue'] }), [0, 1, 2]);
const progression = findExitProgression(graph, 0);
assert.equal(progression.found, true, JSON.stringify(progression));
assert.deepEqual(progression.sectors, [0, 1, 2]);
assert.deepEqual(progression.keys, ['blue']);
assert.equal(progression.transitions[0].acquiredKeys.includes('blue'), true);
assert.equal(progression.exit.special, 11);
console.error('P1.3 synthetic navigation/keyed-door/exit progression passed');

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'doom1.wad'));
const real = new GeometryWorkspace(extractMapPwad(source, 'E1M1'), 'E1M1');
const realGraph = buildNavigationGraph(real);
assert.equal(realGraph.nodes.length, real.geometry.sectors.length);
assert.ok(realGraph.summary.directedEdges > 0);
assert.ok(realGraph.summary.passableEdges > 0);
assert.ok(realGraph.things.starts.some(start => start.doomEdNum === 1 && start.sector != null), JSON.stringify(realGraph.things.starts));
assert.ok(realGraph.exits.length > 0, 'E1M1 should expose at least one Vanilla exit linedef');
const p1 = realGraph.things.starts.find(start => start.doomEdNum === 1);
const adjacent = realGraph.edges.find(edge => edge.from === p1.sector && edge.passable && !edge.requiredKey);
assert.ok(adjacent, `Player 1 start sector ${p1.sector} should have a passable outgoing edge`);
const localPath = findSectorPath(realGraph, p1.sector, adjacent.to);
assert.equal(localPath.found, true);
assert.equal(localPath.edges.length, 1);
console.error('P1.3 real E1M1 graph/start/exit/passable-edge inspection passed:', JSON.stringify(realGraph.summary));
