import assert from 'node:assert/strict';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { installAutoRepair } from './auto_repair.js';
import { markWorkspaceAsGenerated } from './blank_map.js';
import {
  BOT_SKILL_PRESETS,
  canonicalDeathmatchLumpOrder,
  compareDeathmatchReports,
  createDeathmatchArenaPwad,
  evaluateDeathmatchFairness,
  resolveBotSkill
} from './deathmatch_design.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

function markEpisodeGenerated(episode) {
  for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
  for (const workspace of episode.baselines.values()) markWorkspaceAsGenerated(workspace);
  return episode;
}

const generated = createDeathmatchArenaPwad({ map: 'E1M1', outerRadius: 640, innerRadius: 224 });
assert.equal(canonicalDeathmatchLumpOrder(generated.bytes, 'E1M1'), true);
assert.equal(generated.arena.deathmatchStarts, 8);
assert.equal(generated.arena.playerStarts, 4);
assert.equal(generated.arena.sectors, 9);

const episode = markEpisodeGenerated(new EpisodeWorkspace(generated.bytes, ['E1M1'], 'p2.2-generated-arena'));
const workspace = episode.workspaces.get('E1M1');
const validation = episode.validate();
assert.equal(validation.ok, true, JSON.stringify(validation));
const goodCandidate = await episode.build({ filename: 'p2-deathmatch-good.wad' });
for (const map of goodCandidate.maps) assert.equal(map.inspected.ok, true, JSON.stringify(map.inspected));
const goodWorkspace = new GeometryWorkspace(goodCandidate.bytes, 'E1M1');
installThingAuthoring(GeometryWorkspace);
const good = evaluateDeathmatchFairness(goodWorkspace);
assert.ok(good.metrics.deathmatchStarts >= 8, JSON.stringify(good.metrics));
assert.ok(good.metrics.weapons >= 5, JSON.stringify(good.metrics));
assert.ok(good.metrics.loops >= 2, JSON.stringify(good.metrics));
assert.ok(good.componentScores.weaponAccess >= 70, JSON.stringify(good.componentScores));
assert.ok(good.componentScores.highValueEquity >= 70, JSON.stringify(good.componentScores));

// Deliberately bias one spawn and the contested rocket pickup toward another spawn.
const things = workspace.listThings({ limit: 65535 });
const starts = things.filter(thing => Number(thing.doomEdNum) === 11);
const rocket = things.find(thing => Number(thing.doomEdNum) === 2003);
assert.ok(starts.length >= 8 && rocket);
episode.beginTransaction('P2.2 deliberately unfair spawn/resource bias');
episode.applyEdits([
  { type: 'thing_move', map: 'E1M1', thing: starts[0].index, x: starts[1].x + 48, y: starts[1].y + 16, angle: starts[1].angle },
  { type: 'thing_move', map: 'E1M1', thing: rocket.index, x: starts[1].x - 24, y: starts[1].y - 24, angle: 0 }
]);
const badValidation = episode.validate({ touchedOnly: true });
assert.equal(badValidation.ok, true, JSON.stringify(badValidation));
assert.equal(episode.commitTransaction().committed, true);
const badCandidate = await episode.build({ filename: 'p2-deathmatch-bad.wad' });
const bad = evaluateDeathmatchFairness(new GeometryWorkspace(badCandidate.bytes, 'E1M1'));
const comparison = compareDeathmatchReports(bad, good);
assert.ok(bad.overallScore < good.overallScore, JSON.stringify({ good: good.overallScore, bad: bad.overallScore, comparison }));
assert.ok(bad.metrics.minPairwiseSpawnCost < good.metrics.minPairwiseSpawnCost, JSON.stringify({ good: good.metrics, bad: bad.metrics }));
assert.ok(bad.metrics.highValueCostCv > good.metrics.highValueCostCv, JSON.stringify({ good: good.metrics, bad: bad.metrics }));
assert.ok(comparison.delta > 0, JSON.stringify(comparison));

for (const name of ['easy', 'normal', 'hard', 'nightmare']) {
  const resolved = resolveBotSkill(name);
  assert.equal(resolved.name, name);
  assert.equal(resolved.reactionTics, BOT_SKILL_PRESETS[name].reactionTics);
}
assert.ok(resolveBotSkill('nightmare').reactionTics < resolveBotSkill('easy').reactionTics);
assert.ok(resolveBotSkill('nightmare').aimToleranceDeg < resolveBotSkill('easy').aimToleranceDeg);
const custom = resolveBotSkill({ base: 'normal', name: 'sniper-test', reactionTics: 2, aimToleranceDeg: 3, aggression: 0.9 });
assert.equal(custom.name, 'sniper-test');
assert.equal(custom.reactionTics, 2);
assert.equal(custom.aimToleranceDeg, 3);

console.error('P2.2 deterministic deathmatch generation/fairness regression passed:', JSON.stringify({
  arena: generated.arena,
  good: { score: good.overallScore, grade: good.grade, components: good.componentScores, metrics: good.metrics, issues: good.issues.map(row => row.code) },
  deliberatelyUnfair: { score: bad.overallScore, grade: bad.grade, metrics: bad.metrics, issues: bad.issues.map(row => row.code) },
  restoredDelta: comparison.delta,
  botSkills: Object.fromEntries(Object.entries(BOT_SKILL_PRESETS).map(([name, profile]) => [name, { reactionTics: profile.reactionTics, aimToleranceDeg: profile.aimToleranceDeg, aggression: profile.aggression }]))
}));
