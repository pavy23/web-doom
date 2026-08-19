import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'doom1.wad'));
const workspace = new GeometryWorkspace(source, 'E1M1');

const flats = [];
for (const sector of workspace.geometry.sectors) {
  const pair = `${sector.floorFlat}/${sector.ceilingFlat}`;
  if (!flats.includes(pair)) flats.push(pair);
  if (flats.length >= 12) break;
}

const wallTextures = [];
for (const line of workspace.geometry.linedefs) {
  if (line.right === 0xffff) continue;
  const side = workspace.geometry.sidedefs[line.right];
  if (!side) continue;
  for (const texture of [side.middle, side.upper, side.lower]) {
    if (texture && texture !== '-' && !wallTextures.includes(texture)) wallTextures.push(texture);
  }
  if (wallTextures.length >= 16) break;
}

const seedDefaults = { wallTexture: 'STARTAN3', floorFlat: 'FLOOR4_8', ceilingFlat: 'CEIL3_5' };
assert.ok(flats.includes(`${seedDefaults.floorFlat}/${seedDefaults.ceilingFlat}`), 'P2 seed flat pair must be used by shareware E1M1');
assert.ok(wallTextures.includes(seedDefaults.wallTexture), 'P2 seed wall texture must be used by shareware E1M1');

console.log('P2 shareware material probe:', JSON.stringify({
  seedDefaults,
  e1m1FlatPairs: flats,
  e1m1WallTextures: wallTextures,
  defaultFlatPairAppearsInE1M1: true,
  defaultWallAppearsInE1M1: true
}));
