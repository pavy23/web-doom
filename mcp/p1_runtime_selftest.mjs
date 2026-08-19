import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { runBrowserEpisodeExperiment } from './episode_experiment_browser.mjs';
import { startBridge } from './server.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
startBridge();

const here = path.dirname(fileURLToPath(import.meta.url));
const exportDir = path.join(here, 'exports');
await mkdir(exportDir, { recursive: true });
const source = await readFile(path.join(here, '..', 'doom1.wad'));
const episode = new EpisodeWorkspace(source, ['E1M1'], 'doom1.wad');
const workspace = episode.workspaces.get('E1M1');
const player = workspace.listThings({ query: 'player1_start', limit: 1 })[0];
assert.ok(player);

episode.beginTransaction('P1.1 runtime thing smoke');
episode.applyEdits([
  { type: 'thing_add', map: 'E1M1', key: 'rocket_launcher', x: player.x + 64, y: player.y + 32, angle: 90 },
  { type: 'thing_add', map: 'E1M1', key: 'medikit', x: player.x + 96, y: player.y + 32, angle: 0 }
]);
assert.equal(episode.commitTransaction().committed, true);
const candidate = await episode.build({ filename: 'p1-runtime-things.wad' });
const wadPath = path.join(exportDir, candidate.filename);
await writeFile(wadPath, candidate.bytes);

const report = await runBrowserEpisodeExperiment({
  experimentId: 'p1-runtime-things',
  filename: candidate.filename,
  wadPath,
  reportDir: path.join(exportDir, 'experiments', 'p1-runtime-things'),
  maps: ['E1M1'],
  smokeTics: 2,
  captureFrames: true,
  stopOnFailure: true
});
assert.equal(report.passed, true, JSON.stringify(report));
assert.equal(report.results.length, 1);
assert.equal(report.results[0].map, 'E1M1');
console.error('P1.1 authored THINGS cold-boot runtime smoke passed');
process.exit(0);
