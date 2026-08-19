import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { runBrowserEpisodeExperiment } from './episode_experiment_browser.mjs';
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

function usableOneSidedLines(workspace) {
  return workspace.geometry.linedefs.map((line, index) => ({ line, index })).filter(({ line }) => {
    if (line.left !== NO_SIDE || line.right === NO_SIDE) return false;
    const a = workspace.geometry.vertices[line.v1];
    const b = workspace.geometry.vertices[line.v2];
    return a && b && Math.hypot(b.x - a.x, b.y - a.y) >= 64;
  });
}

function findSafeWallEdit(map, makeEdit) {
  const scratch = new EpisodeWorkspace(source, [map], 'doom1.wad');
  const workspace = scratch.workspaces.get(map);
  for (const { index } of usableOneSidedLines(workspace)) {
    const edit = { ...makeEdit(index), map };
    try {
      scratch.beginTransaction(`probe ${edit.type} ${map} line ${index}`);
      scratch.applyEdits([edit]);
      const validation = scratch.validate({ touchedOnly: true });
      if (validation.ok) {
        scratch.rollbackTransaction();
        return edit;
      }
      scratch.rollbackTransaction();
    } catch {
      if (scratch.transaction) scratch.rollbackTransaction();
    }
  }
  throw new Error(`Could not find a P0-safe wall for ${map} ${makeEdit(0).type}`);
}

function findSafeSplit(map) {
  const scratch = new EpisodeWorkspace(source, [map], 'doom1.wad');
  const workspace = scratch.workspaces.get(map);
  for (let sector = 0; sector < workspace.geometry.sectors.length; sector++) {
    let boundary;
    try { boundary = workspace.getSectorBoundary({ sector }); }
    catch { continue; }
    if (boundary.vertices.length < 4 || boundary.vertices.length > 20) continue;
    const n = boundary.vertices.length;
    for (let a = 0; a < n; a++) {
      for (let b = a + 2; b < n; b++) {
        if (a === 0 && b === n - 1) continue;
        const edit = {
          type: 'split_sector', map, sector,
          vertexA: boundary.vertices[a], vertexB: boundary.vertices[b]
        };
        try {
          scratch.beginTransaction(`probe split ${map} sector ${sector}`);
          scratch.applyEdits([edit]);
          const validation = scratch.validate({ touchedOnly: true });
          if (validation.ok) {
            scratch.rollbackTransaction();
            return edit;
          }
          scratch.rollbackTransaction();
        } catch {
          if (scratch.transaction) scratch.rollbackTransaction();
        }
      }
    }
  }
  throw new Error(`Could not find a P0-safe simple sector split in ${map}`);
}

const edits = [
  findSafeWallEdit('E1M1', line => ({
    type: 'add_polygon_room', line, sides: 5, depth: 96, wallTexture: 'STARTAN3'
  })),
  findSafeWallEdit('E1M2', line => ({
    type: 'add_staircase', line, steps: 3, stepDepth: 24, stepHeight: 8,
    landingDepth: 48, wallTexture: 'STARTAN3', riserTexture: 'STARTAN3'
  })),
  findSafeWallEdit('E1M3', line => ({
    type: 'add_door_room', line, key: 'none', behavior: 'raise',
    doorDepth: 16, roomDepth: 64,
    doorTexture: 'STARTAN3', trackTexture: 'STARTAN3', roomWallTexture: 'STARTAN3'
  })),
  findSafeWallEdit('E1M4', line => ({
    type: 'add_lift_room', line, rise: 32, liftDepth: 32, roomDepth: 64,
    clearance: 96, wallTexture: 'STARTAN3'
  })),
  findSafeSplit('E1M5')
];

console.error('P1.2 runtime-safe real-map edits:', JSON.stringify(edits));
const maps = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5'];
const episode = new EpisodeWorkspace(source, maps, 'doom1.wad');
episode.beginTransaction('P1.2 real-map semantic runtime smoke');
const applied = episode.applyEdits(edits);
assert.equal(applied.results.length, edits.length);
const validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation));
const commit = episode.commitTransaction();
assert.equal(commit.committed, true, JSON.stringify(commit));
assert.deepEqual(new Set(commit.transaction.touchedMaps), new Set(maps));

const candidate = await episode.build({ filename: 'p1-semantic-runtime.wad' });
assert.equal(candidate.maps.length, maps.length);
for (const entry of candidate.maps) assert.equal(entry.inspected.ok, true, JSON.stringify(entry.inspected));
const wadPath = path.join(exportDir, candidate.filename);
await writeFile(wadPath, candidate.bytes);

const report = await runBrowserEpisodeExperiment({
  experimentId: 'p1-semantic-runtime',
  filename: candidate.filename,
  wadPath,
  reportDir: path.join(exportDir, 'experiments', 'p1-semantic-runtime'),
  maps,
  smokeTics: 2,
  captureFrames: true,
  stopOnFailure: true
});
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(report.results.length, maps.length);
assert.deepEqual(report.results.map(result => result.map), maps);
assert.ok(report.results.every(result => result.passed), JSON.stringify(report.results));
console.error('P1.2 real E1M1-E1M5 semantic PWAD cold-boot runtime regression passed:', JSON.stringify(report.summary));
process.exit(0);
