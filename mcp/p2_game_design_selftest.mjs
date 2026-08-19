import assert from 'node:assert/strict';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { createSeededBlankMapPwad, markWorkspaceAsGenerated } from './blank_map.js';
import { compareGameDesignReports, evaluateGameDesign, getGameDesignPolicy } from './game_design_evaluator.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);

const policy = getGameDesignPolicy();
assert.equal(policy.version, '2026-08-p2.1');
assert.deepEqual(Object.keys(policy.profiles).sort(), ['balanced', 'combat', 'exploration']);

const generated = createSeededBlankMapPwad({ map: 'E1M1', width: 512, height: 384, exitWall: 'east' });
const episode = new EpisodeWorkspace(generated.bytes, ['E1M1'], 'p2.1-game-design-selftest');
for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
for (const baseline of episode.baselines.values()) markWorkspaceAsGenerated(baseline);

// Deliberately poor combat balance: one very high-threat enemy with no authored
// weapon/ammo/health/armor support. The geometry itself remains valid/playable.
episode.beginTransaction('P2.1 create under-supported combat candidate');
episode.applyEdits([
  { type: 'thing_add', map: 'E1M1', key: 'cyberdemon', x: 128, y: 0, angle: 180 }
]);
let validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation));
assert.equal(episode.commitTransaction().committed, true);

const beforeCandidate = await episode.build({ filename: 'p2.1-before.wad' });
assert.equal(beforeCandidate.maps[0].inspected.ok, true, JSON.stringify(beforeCandidate.maps[0].inspected));
const beforeWorkspace = new GeometryWorkspace(beforeCandidate.bytes, 'E1M1');
const before = evaluateGameDesign(beforeWorkspace, { profile: 'balanced', skill: 'medium' });
const beforeRepeat = evaluateGameDesign(beforeWorkspace, { profile: 'balanced', skill: 'medium' });
assert.deepEqual(beforeRepeat, before, 'P2.1 evaluation must be deterministic');
assert.equal(before.metrics.monsterCount, 1);
assert.equal(before.metrics.totalThreat, 40);
assert.equal(before.metrics.totalSupport, 0);
assert.ok(before.issues.some(row => row.code === 'RESOURCE_STARVATION'), JSON.stringify(before.issues));
assert.ok(before.issues.some(row => row.code === 'NO_EARLY_WEAPON'), JSON.stringify(before.issues));

// Improve only gameplay support, not geometry. The evaluator should show a
// measurable resource-balance improvement under the exact same policy.
episode.beginTransaction('P2.1 support the combat candidate');
episode.applyEdits([
  { type: 'thing_add', map: 'E1M1', key: 'shotgun', x: -128, y: 72, angle: 0 },
  { type: 'thing_add', map: 'E1M1', key: 'ammo_box', x: -72, y: 120, angle: 0 },
  { type: 'thing_add', map: 'E1M1', key: 'box_of_shells', x: -72, y: -120, angle: 0 },
  { type: 'thing_add', map: 'E1M1', key: 'medikit', x: -184, y: 104, angle: 0 },
  { type: 'thing_add', map: 'E1M1', key: 'medikit', x: -184, y: -104, angle: 0 },
  { type: 'thing_add', map: 'E1M1', key: 'green_armor', x: -72, y: 0, angle: 0 }
]);
validation = episode.validate({ touchedOnly: true });
assert.equal(validation.ok, true, JSON.stringify(validation));
assert.equal(episode.commitTransaction().committed, true);

const afterCandidate = await episode.build({ filename: 'p2.1-after.wad' });
assert.equal(afterCandidate.maps[0].inspected.ok, true, JSON.stringify(afterCandidate.maps[0].inspected));
const afterWorkspace = new GeometryWorkspace(afterCandidate.bytes, 'E1M1');
const after = evaluateGameDesign(afterWorkspace, { profile: 'balanced', skill: 'medium' });
const comparison = compareGameDesignReports(before, after);

assert.ok(after.metrics.totalSupport > before.metrics.totalSupport, JSON.stringify({ before: before.metrics, after: after.metrics }));
assert.ok(after.componentScores.resources > before.componentScores.resources, JSON.stringify({ before: before.componentScores, after: after.componentScores }));
assert.ok(after.overallScore > before.overallScore, JSON.stringify({ before: before.overallScore, after: after.overallScore }));
assert.ok(!after.issues.some(row => row.code === 'RESOURCE_STARVATION'), JSON.stringify(after.issues));
assert.ok(!after.issues.some(row => row.code === 'NO_EARLY_WEAPON'), JSON.stringify(after.issues));
assert.ok(comparison.resolvedIssues.includes('RESOURCE_STARVATION'), JSON.stringify(comparison));
assert.ok(comparison.overall.delta > 0, JSON.stringify(comparison));

// Profile weighting is intentional: the exact same sparse map should not be
// interpreted identically by a combat-oriented and exploration-oriented brief.
const combatView = evaluateGameDesign(afterWorkspace, { profile: 'combat', skill: 'medium' });
const explorationView = evaluateGameDesign(afterWorkspace, { profile: 'exploration', skill: 'medium' });
assert.notEqual(combatView.overallScore, explorationView.overallScore);

console.error('P2.1 deterministic game-design evaluation passed:', JSON.stringify({
  before: { score: before.overallScore, grade: before.grade, resources: before.componentScores.resources, issues: before.issues.map(row => row.code) },
  after: { score: after.overallScore, grade: after.grade, resources: after.componentScores.resources, issues: after.issues.map(row => row.code) },
  delta: comparison.overall.delta,
  resolvedIssues: comparison.resolvedIssues,
  profileScores: { combat: combatView.overallScore, exploration: explorationView.overallScore }
}));
