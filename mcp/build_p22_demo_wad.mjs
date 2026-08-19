import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { installAutoRepair } from './auto_repair.js';
import { markWorkspaceAsGenerated } from './blank_map.js';
import { createBalancedDeathmatchArenaPwad } from './deathmatch_factory.js';
import { evaluateDeathmatchFairness } from './deathmatch_design.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

const output = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'p22-demo.wad'));
const generated = createBalancedDeathmatchArenaPwad({ map: 'E1M1', outerRadius: 640, innerRadius: 224 });
const episode = new EpisodeWorkspace(generated.bytes, ['E1M1'], 'public-p2.2-demo');
for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
for (const workspace of episode.baselines.values()) markWorkspaceAsGenerated(workspace);

const validation = episode.validate();
assert.equal(validation.ok, true, JSON.stringify(validation));
const built = await episode.build({ filename: path.basename(output) });
assert.equal(built.maps[0].inspected.ok, true, JSON.stringify(built.maps[0].inspected));

const fairness = evaluateDeathmatchFairness(new GeometryWorkspace(built.bytes, 'E1M1'));
assert.ok(fairness.overallScore >= 80, JSON.stringify(fairness));
assert.ok(fairness.componentScores.weaponAccess >= 95, JSON.stringify(fairness.componentScores));
assert.ok(fairness.componentScores.highValueEquity >= 95, JSON.stringify(fairness.componentScores));
assert.equal(fairness.metrics.deathmatchStarts, 8);

await writeFile(output, built.bytes);
console.log(JSON.stringify({
  output,
  bytes: built.bytes.length,
  map: 'E1M1',
  score: fairness.overallScore,
  grade: fairness.grade,
  deathmatchStarts: fairness.metrics.deathmatchStarts,
  loops: fairness.metrics.loops,
  nearestWeaponCostCv: fairness.metrics.nearestWeaponCostCv,
  highValueCostCv: fairness.metrics.highValueCostCv
}, null, 2));
