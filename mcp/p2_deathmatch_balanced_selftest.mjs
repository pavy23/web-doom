import assert from 'node:assert/strict';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { installAutoRepair } from './auto_repair.js';
import { markWorkspaceAsGenerated } from './blank_map.js';
import { createBalancedDeathmatchArenaPwad } from './deathmatch_factory.js';
import { BOT_SKILL_PRESETS, compareDeathmatchReports, evaluateDeathmatchFairness, resolveBotSkill } from './deathmatch_design.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

function markGenerated(episode) {
  for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
  for (const workspace of episode.baselines.values()) markWorkspaceAsGenerated(workspace);
  return episode;
}

const generated = createBalancedDeathmatchArenaPwad({ map: 'E1M1', outerRadius: 640, innerRadius: 224 });
const episode = markGenerated(new EpisodeWorkspace(generated.bytes, ['E1M1'], 'p2.2-balanced-deathmatch'));
const workspace = episode.workspaces.get('E1M1');
const validation = episode.validate();
assert.equal(validation.ok, true, JSON.stringify(validation));
const built = await episode.build({ filename: 'p2-deathmatch-balanced.wad' });
assert.equal(built.maps[0].inspected.ok, true, JSON.stringify(built.maps[0].inspected));
const balanced = evaluateDeathmatchFairness(new GeometryWorkspace(built.bytes, 'E1M1'));
assert.equal(balanced.metrics.deathmatchStarts, 8);
// Eight equal-access spawn shotguns plus the contested central rocket.
assert.ok(balanced.metrics.weapons >= 9, JSON.stringify(balanced.metrics));
assert.ok(balanced.metrics.loops >= 2, JSON.stringify(balanced.metrics));
assert.ok(balanced.componentScores.weaponAccess >= 85, JSON.stringify(balanced.componentScores));
assert.ok(balanced.componentScores.highValueEquity >= 85, JSON.stringify(balanced.componentScores));
assert.ok(balanced.overallScore >= 70, JSON.stringify(balanced));

// Create an explicitly unfair version by clustering one start and moving the center rocket toward another spawn.
const things = workspace.listThings({ limit: 65535 });
const starts = things.filter(thing => Number(thing.doomEdNum) === 11);
const rocket = things.find(thing => Number(thing.doomEdNum) === 2003);
assert.ok(starts.length >= 8 && rocket);
episode.beginTransaction('P2.2 unfairness injection');
episode.applyEdits([
  { type: 'thing_move', map: 'E1M1', thing: starts[0].index, x: starts[1].x + 48, y: starts[1].y + 16, angle: starts[1].angle },
  { type: 'thing_move', map: 'E1M1', thing: rocket.index, x: starts[1].x - 24, y: starts[1].y - 24, angle: 0 }
]);
const unfairValidation = episode.validate({ touchedOnly: true });
assert.equal(unfairValidation.ok, true, JSON.stringify(unfairValidation));
assert.equal(episode.commitTransaction().committed, true);
const unfairBuilt = await episode.build({ filename: 'p2-deathmatch-unfair.wad' });
const unfair = evaluateDeathmatchFairness(new GeometryWorkspace(unfairBuilt.bytes, 'E1M1'));
const comparison = compareDeathmatchReports(unfair, balanced);
assert.ok(unfair.overallScore < balanced.overallScore, JSON.stringify({ balanced: balanced.overallScore, unfair: unfair.overallScore, comparison }));
assert.ok(unfair.metrics.minPairwiseSpawnCost < balanced.metrics.minPairwiseSpawnCost, JSON.stringify({ balanced: balanced.metrics, unfair: unfair.metrics }));
assert.ok(unfair.metrics.highValueCostCv > balanced.metrics.highValueCostCv, JSON.stringify({ balanced: balanced.metrics, unfair: unfair.metrics }));
assert.ok(comparison.delta > 0, JSON.stringify(comparison));

for (const skill of Object.keys(BOT_SKILL_PRESETS)) {
  const profile = resolveBotSkill(skill);
  assert.equal(profile.name, skill);
  assert.equal(profile.reactionTics, BOT_SKILL_PRESETS[skill].reactionTics);
}
const easy = resolveBotSkill('easy');
const nightmare = resolveBotSkill('nightmare');
assert.ok(nightmare.reactionTics < easy.reactionTics);
assert.ok(nightmare.aimToleranceDeg < easy.aimToleranceDeg);
assert.ok(nightmare.aggression > easy.aggression);

console.error('P2.2 balanced deathmatch regression passed:', JSON.stringify({
  arena: generated.arena,
  balanced: { score: balanced.overallScore, grade: balanced.grade, components: balanced.componentScores, metrics: balanced.metrics, issues: balanced.issues.map(row => row.code) },
  unfair: { score: unfair.overallScore, grade: unfair.grade, components: unfair.componentScores, metrics: unfair.metrics, issues: unfair.issues.map(row => row.code) },
  restoredDelta: comparison.delta,
  botSkills: Object.fromEntries(Object.keys(BOT_SKILL_PRESETS).map(skill => [skill, resolveBotSkill(skill)]))
}));
