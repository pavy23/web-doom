import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startBridge } from './server.js';
import { GeometryWorkspace } from './geometry.js';
import { DEFAULT_EPISODE_MAPS, EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { runBrowserEpisodeExperiment } from './episode_experiment_browser.mjs';

installFullTopologyValidator(GeometryWorkspace);
startBridge();

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'doom1.wad'));
const exportsDir = path.join(here, 'exports');
const reportDir = path.join(exportsDir, 'experiments', 'ci-p0-experiment');
const filename = 'p0-experiment-selftest.wad';
const wadPath = path.join(exportsDir, filename);

await mkdir(reportDir, { recursive: true });

const workspace = new EpisodeWorkspace(source, DEFAULT_EPISODE_MAPS, 'doom1.wad');
const baselineValidation = workspace.validate();
assert.equal(baselineValidation.ok, true, JSON.stringify(baselineValidation));

const candidate = await workspace.build({ filename });
assert.equal(candidate.maps.length, DEFAULT_EPISODE_MAPS.length);
await mkdir(exportsDir, { recursive: true });
await writeFile(wadPath, candidate.bytes);

const report = await runBrowserEpisodeExperiment({
  experimentId: 'ci-p0-experiment',
  filename,
  wadPath,
  reportDir,
  maps: DEFAULT_EPISODE_MAPS,
  smokeTics: 14,
  captureFrames: true,
  stopOnFailure: false
});

assert.equal(report.passed, true, JSON.stringify(report.results));
assert.equal(report.results.length, 8);
assert.ok(report.results.every(result => result.passed));
assert.ok(report.results.every(result => result.executedTics === 14));
assert.ok(report.results.every(result => result.frame?.screenshot));
console.error('P0 automated E1M1-E1M8 experiment runner passed:', JSON.stringify(report.summary));
process.exit(0);
