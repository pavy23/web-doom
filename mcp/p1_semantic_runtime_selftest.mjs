import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace, writeWad } from './geometry.js';
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

function name8(value) {
  const out = Buffer.alloc(8); out.write(String(value), 0, 8, 'ascii'); return out;
}
function makeSyntheticMap() {
  const vertices = Buffer.alloc(4 * 4);
  [[0, 0], [0, 256], [256, 256], [256, 0]].forEach(([x, y], i) => {
    vertices.writeInt16LE(x, i * 4); vertices.writeInt16LE(y, i * 4 + 2);
  });
  const sidedefs = Buffer.alloc(4 * 30);
  for (let i = 0; i < 4; i++) {
    const at = i * 30;
    name8('-').copy(sidedefs, at + 4);
    name8('-').copy(sidedefs, at + 12);
    name8('STARTAN3').copy(sidedefs, at + 20);
    sidedefs.writeUInt16LE(0, at + 28);
  }
  const linedefs = Buffer.alloc(4 * 14);
  [[0, 1], [1, 2], [2, 3], [3, 0]].forEach(([v1, v2], i) => {
    const at = i * 14;
    linedefs.writeUInt16LE(v1, at);
    linedefs.writeUInt16LE(v2, at + 2);
    linedefs.writeUInt16LE(1, at + 4);
    linedefs.writeUInt16LE(i, at + 10);
    linedefs.writeUInt16LE(0xffff, at + 12);
  });
  const sectors = Buffer.alloc(26);
  sectors.writeInt16LE(0, 0); sectors.writeInt16LE(128, 2);
  name8('FLOOR0_1').copy(sectors, 4); name8('CEIL1_1').copy(sectors, 12);
  sectors.writeInt16LE(160, 20);
  const things = Buffer.alloc(10);
  things.writeInt16LE(64, 0); things.writeInt16LE(128, 2); things.writeInt16LE(0, 4);
  things.writeInt16LE(1, 6); things.writeInt16LE(7, 8);
  return writeWad({ lumps: [
    { name: 'E1M1', data: Buffer.alloc(0) },
    { name: 'THINGS', data: things },
    { name: 'LINEDEFS', data: linedefs },
    { name: 'SIDEDEFS', data: sidedefs },
    { name: 'VERTEXES', data: vertices },
    { name: 'SEGS', data: Buffer.alloc(0) },
    { name: 'SSECTORS', data: Buffer.alloc(0) },
    { name: 'NODES', data: Buffer.alloc(0) },
    { name: 'SECTORS', data: sectors },
    { name: 'REJECT', data: Buffer.alloc(0) },
    { name: 'BLOCKMAP', data: Buffer.alloc(0) }
  ] }, 'PWAD');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.join(here, 'exports');
await mkdir(exportDir, { recursive: true });

const episode = new EpisodeWorkspace(makeSyntheticMap(), ['E1M1'], 'p1.2-synthetic.wad');
episode.beginTransaction('P1.2 complete semantic runtime smoke');
const applied = episode.applyEdits([
  { type: 'add_polygon_room', map: 'E1M1', line: 1, sides: 6, depth: 128, wallTexture: 'STARTAN3' },
  { type: 'add_staircase', map: 'E1M1', line: 2, steps: 4, stepDepth: 32, stepHeight: 8, landingDepth: 64, wallTexture: 'STARTAN3' },
  { type: 'add_door_room', map: 'E1M1', line: 3, key: 'none', behavior: 'raise', doorDepth: 24, roomDepth: 96, doorTexture: 'STARTAN3', trackTexture: 'STARTAN3', roomWallTexture: 'STARTAN3' },
  { type: 'add_lift_room', map: 'E1M1', line: 0, rise: 64, liftDepth: 48, roomDepth: 96, wallTexture: 'STARTAN3' },
  { type: 'split_sector', map: 'E1M1', sector: 0, vertexA: 0, vertexB: 2 },
  { type: 'thing_add', map: 'E1M1', key: 'shotgun', x: 96, y: 128, angle: 0 }
]);
assert.equal(applied.results.length, 6);
const validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation));
const commit = episode.commitTransaction();
assert.equal(commit.committed, true, JSON.stringify(commit));

const candidate = await episode.build({ filename: 'p1-semantic-runtime.wad' });
assert.equal(candidate.maps[0].inspected.ok, true, JSON.stringify(candidate.maps[0].inspected));
const wadPath = path.join(exportDir, candidate.filename);
await writeFile(wadPath, candidate.bytes);

const report = await runBrowserEpisodeExperiment({
  experimentId: 'p1-semantic-runtime',
  filename: candidate.filename,
  wadPath,
  reportDir: path.join(exportDir, 'experiments', 'p1-semantic-runtime'),
  maps: ['E1M1'],
  smokeTics: 4,
  captureFrames: true,
  stopOnFailure: true
});
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(report.results.length, 1);
assert.equal(report.results[0].map, 'E1M1');
assert.ok(report.results[0].frame?.screenshot || report.results[0].telemetry, JSON.stringify(report.results[0]));
console.error('P1.2 semantic geometry synthetic PWAD cold-boot runtime smoke passed');
process.exit(0);
