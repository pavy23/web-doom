import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace, MAP_LUMP_ORDER, parseWad } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring, listThingCatalog } from './thing_authoring.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'doom1.wad'));

function thingsFor(bytes, mapName) {
  const doc = parseWad(bytes);
  const marker = doc.lumps.findIndex(lump => lump.name === mapName);
  assert.ok(marker >= 0, `${mapName} marker missing`);
  const thingsIndex = MAP_LUMP_ORDER.indexOf('THINGS');
  const data = doc.lumps[marker + 1 + thingsIndex].data;
  assert.equal(data.length % 10, 0);
  return data.length / 10;
}

const catalog = listThingCatalog({});
for (const key of ['player1_start', 'deathmatch_start', 'imp', 'rocket_launcher', 'medikit', 'red_keycard', 'barrel']) {
  assert.ok(catalog.some(item => item.key === key), `catalog missing ${key}`);
}
console.error('P1.1 THINGS catalog passed:', catalog.length, 'named types');

const episode = new EpisodeWorkspace(source, ['E1M1', 'E1M2'], 'doom1.wad');
const e1m1 = episode.workspaces.get('E1M1');
const e1m2 = episode.workspaces.get('E1M2');
const baseline1 = e1m1.listThings({ limit: 4096 });
const baseline2 = e1m2.listThings({ limit: 4096 });
assert.ok(baseline1.length > 0 && baseline2.length > 0);
const playerStart = baseline1.find(thing => thing.key === 'player1_start');
assert.ok(playerStart, 'E1M1 player 1 start not found');
console.error('P1.1 baseline THINGS parsed:', { E1M1: baseline1.length, E1M2: baseline2.length });

// Add two general things, move one, and change its multiplayer/skill flags.
episode.beginTransaction('P1.1 general thing add/move/update');
const applied = episode.applyEdits([
  {
    type: 'thing_add', map: 'E1M1', key: 'rocket_launcher',
    x: playerStart.x + 64, y: playerStart.y, angle: 90,
    skillEasy: true, skillMedium: true, skillHard: true
  },
  {
    type: 'thing_add', map: 'E1M1', key: 'deathmatch_start',
    x: playerStart.x + 128, y: playerStart.y + 64, angle: 180
  }
]);
const rocketIndex = applied.results[0].result.index;
const dmIndex = applied.results[1].result.index;
episode.applyEdits([
  { type: 'thing_move', map: 'E1M1', thing: rocketIndex, x: playerStart.x + 96, y: playerStart.y + 32, angle: 135 },
  { type: 'thing_update', map: 'E1M1', thing: rocketIndex, multiplayerOnly: true, skillEasy: false, skillMedium: true, skillHard: true }
]);
const txValidation = episode.validate({ touchedOnly: true });
assert.equal(txValidation.ok, true, JSON.stringify(txValidation));
const commit = episode.commitTransaction();
assert.equal(commit.committed, true, JSON.stringify(commit));

const afterCommit = e1m1.listThings({ limit: 4096 });
assert.equal(afterCommit.length, baseline1.length + 2);
const rocket = afterCommit[rocketIndex];
assert.equal(rocket.key, 'rocket_launcher');
assert.equal(rocket.x, playerStart.x + 96);
assert.equal(rocket.y, playerStart.y + 32);
assert.equal(rocket.angle, 135);
assert.equal(rocket.options.skillEasy, false);
assert.equal(rocket.options.skillMedium, true);
assert.equal(rocket.options.skillHard, true);
assert.equal(rocket.options.multiplayerOnly, true);
assert.equal(afterCommit[dmIndex].key, 'deathmatch_start');
console.error('P1.1 thing add/move/update transaction passed');

// Any later failure must rollback earlier THINGS edits on every touched map.
const preRollback1 = episode.workspaces.get('E1M1').listThings({ limit: 4096 }).length;
const preRollback2 = episode.workspaces.get('E1M2').listThings({ limit: 4096 }).length;
episode.beginTransaction('P1.1 cross-map rollback');
let rolledBack = false;
try {
  episode.applyEdits([
    { type: 'thing_add', map: 'E1M1', key: 'medikit', x: playerStart.x, y: playerStart.y + 96 },
    { type: 'thing_add', map: 'E1M2', doomEdNum: 40000, x: 0, y: 0 }
  ]);
} catch (error) {
  rolledBack = /rolled back/i.test(String(error?.message || error));
}
assert.equal(rolledBack, true);
assert.equal(episode.transaction, null);
assert.equal(episode.workspaces.get('E1M1').listThings({ limit: 4096 }).length, preRollback1);
assert.equal(episode.workspaces.get('E1M2').listThings({ limit: 4096 }).length, preRollback2);
console.error('P1.1 cross-map THINGS rollback passed');

// Delete one authored thing and ensure indices serialize to the real THINGS lump.
episode.beginTransaction('P1.1 delete thing');
episode.applyEdits([{ type: 'thing_delete', map: 'E1M1', thing: dmIndex }]);
const deleteCommit = episode.commitTransaction();
assert.equal(deleteCommit.committed, true);
assert.equal(episode.workspaces.get('E1M1').listThings({ limit: 4096 }).length, baseline1.length + 1);

const candidate = await episode.build({ filename: 'p1-things-selftest.wad' });
assert.equal(candidate.maps.length, 2);
assert.equal(thingsFor(candidate.bytes, 'E1M1'), baseline1.length + 1);
assert.equal(thingsFor(candidate.bytes, 'E1M2'), baseline2.length);
for (const entry of candidate.maps) assert.equal(entry.inspected.ok, true, JSON.stringify(entry.inspected));
console.error('P1.1 THINGS serialization + ZDBSP build passed:', candidate.bytes.length, 'bytes');

const baselinePlacement = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad').validate();
assert.equal(baselinePlacement.ok, true, JSON.stringify(baselinePlacement.issues?.errors || baselinePlacement.errors));
console.error('P1.1 baseline E1M1 still validates with placement checks');

const stuckEpisode = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
stuckEpisode.beginTransaction('stuck baron in tech pillar');
stuckEpisode.applyEdits([{ type: 'thing_add', map: 'E1M1', key: 'baron_of_hell', x: 288, y: -3360, angle: 0 }]);
const stuckValidation = stuckEpisode.validate({ touchedOnly: true });
assert.equal(stuckValidation.ok, false, JSON.stringify(stuckValidation));
assert.ok(
  (stuckValidation.maps?.[0]?.issues?.errors || []).some(row => row.code === 'THING_OVERLAPS_SOLID' || row.code === 'THING_UNLOCATABLE' || row.code === 'THING_OVERLAPS_WALL'),
  JSON.stringify(stuckValidation.maps?.[0]?.issues || stuckValidation)
);
stuckEpisode.rollbackTransaction();
console.error('P1.1 stuck-in-pillar baron is rejected before commit');

stuckEpisode.beginTransaction('baron in clear corridor');
stuckEpisode.applyEdits([{ type: 'thing_add', map: 'E1M1', key: 'baron_of_hell', x: 384, y: -3232, angle: 0 }]);
const clearValidation = stuckEpisode.validate({ touchedOnly: true });
assert.equal(clearValidation.ok, true, JSON.stringify(clearValidation));
assert.equal(stuckEpisode.commitTransaction().committed, true);
console.error('P1.1 clear-corridor baron placement passed');
