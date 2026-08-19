import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { runLocalBotDeathmatch } from './deathmatch_bot_runtime.mjs';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

function markGenerated(episode) {
  for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
  for (const workspace of episode.baselines.values()) markWorkspaceAsGenerated(workspace);
  return episode;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(here, 'exports'));
const reportDir = path.join(exportDir, 'p2-deathmatch-bots', 'runtime-selftest');
await mkdir(reportDir, { recursive: true });

const generated = createBalancedDeathmatchArenaPwad({ map: 'E1M1', outerRadius: 640, innerRadius: 224 });
const episode = markGenerated(new EpisodeWorkspace(generated.bytes, ['E1M1'], 'p2.2-runtime-arena'));
const validation = episode.validate();
assert.equal(validation.ok, true, JSON.stringify(validation));
const candidate = await episode.build({ filename: 'p2-deathmatch-bot-runtime.wad' });
assert.equal(candidate.maps[0].inspected.ok, true, JSON.stringify(candidate.maps[0].inspected));
const fairness = evaluateDeathmatchFairness(new GeometryWorkspace(candidate.bytes, 'E1M1'));
assert.ok(fairness.componentScores.weaponAccess >= 80, JSON.stringify(fairness.componentScores));
const wadPath = path.join(exportDir, 'p2-deathmatch-bot-runtime.wad');
await writeFile(wadPath, candidate.bytes);

// DOOM_MCP_UPSTREAM must point at the branch-local P2.2 webdoom.html served by
// the CI workflow. Import the proxy only after the environment is established.
const { startBridge } = await import('./server.js');
const bridge = startBridge();

try {
  const report = await runLocalBotDeathmatch({
    wadPath,
    filename: 'p2-deathmatch-bot-runtime.wad',
    map: 'E1M1',
    localPlayers: 4,
    // Four different policies prove that per-player difficulty is configurable.
    botSkills: ['easy', 'normal', 'hard', 'nightmare'],
    controlPlayers: [0, 1, 2, 3],
    totalTics: Number(process.env.DOOM_P22_BOT_TICS || 700),
    reportDir,
    captureFrame: true,
    playUrl: `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`
  });
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.final.players.length, 4, JSON.stringify(report.final));
  assert.ok(report.allPlayersMoved, JSON.stringify(report.travelDistance));
  assert.ok(report.totalAttacks >= 4, JSON.stringify(report.attacks));
  assert.ok(report.damageObserved || report.fragObserved, JSON.stringify(report));
  assert.ok(report.decisions[3] > report.decisions[0], JSON.stringify(report.decisions));
  console.error('P2.2 four-player local bot LinuxDOOM runtime passed:', JSON.stringify({
    fairness: { score: fairness.overallScore, grade: fairness.grade },
    skills: report.botSkills,
    decisions: report.decisions,
    attacks: report.attacks,
    travelDistance: report.travelDistance,
    damageObserved: report.damageObserved,
    fragObserved: report.fragObserved,
    final: report.final.players.map(player => ({ player: player.player, health: player.health, frags: player.frags, x: player.x, y: player.y }))
  }));
} finally {
  if (bridge?.close) await bridge.close();
}
