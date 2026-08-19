import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { startBridge as startAuthoringBridge } from './server.js';
import { startPlaytestBridge } from './playtest_server.js';
import { startOrchestrationBridge } from './v1_server.js';
import { startCheatBridge } from './cheat_server.js';

// Import P0 first: it installs the full-topology patch before composing geometry v2.
const p0Module = await import('./p0_server.js');
const geometryModule = await import('./geometry_server.js');
const { DEFAULT_EPISODE_MAPS, EpisodeWorkspace } = await import('./episode_workspace.js');
const { parseWad } = await import('./geometry.js');

const VERSION = '2.1.0-p0.1';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const EXPERIMENT_DIR = path.join(EXPORT_DIR, 'experiments');
const SOURCE_PATH = path.resolve(process.env.DOOM_EPISODE_SOURCE || path.join(MODULE_DIR, '..', 'doom1.wad'));
const RUNNER_PATH = path.join(MODULE_DIR, 'episode_experiment_browser.mjs');
const execFileAsync = promisify(execFile);
let experimentCounter = 1;

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }

function normalizeMapName(value) {
  const map = String(value || '').trim().toUpperCase();
  if (!/^(?:E[1-9]M[1-9]|MAP\d\d)$/.test(map)) throw new Error(`Unsupported map name: ${value}`);
  return map;
}

function safeFilename(requested, fallback) {
  const raw = String(requested || fallback).trim() || fallback;
  if (raw !== path.basename(raw)) throw new Error('Experiment WAD filename must not contain a path');
  const withExt = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = withExt.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  if (!safe || safe !== withExt) throw new Error('Experiment WAD filename contains unsupported characters');
  return safe;
}

function exportPath(filename) {
  const resolved = path.resolve(EXPORT_DIR, filename);
  if (path.dirname(resolved) !== EXPORT_DIR) throw new Error('Experiment WAD path escapes export directory');
  return resolved;
}

function experimentId() {
  return `episode-exp-${Date.now()}-${String(experimentCounter++).padStart(3, '0')}`;
}

function inspectMapMarkers(bytes) {
  const doc = parseWad(bytes);
  return doc.lumps.map(lump => lump.name).filter(name => /^(?:E[1-9]M[1-9]|MAP\d\d)$/.test(name));
}

function createSafeHeightNudgeEdits(workspace) {
  const edits = [];
  for (const map of workspace.mapNames) {
    const geometry = workspace.workspaces.get(map)?.geometry;
    if (!geometry) throw new Error(`Missing geometry workspace for ${map}`);
    const sector = geometry.sectors.findIndex(item =>
      Number(item.special || 0) === 0
        && Number(item.tag || 0) === 0
        && Number(item.ceiling) - Number(item.floor) >= 64
        && Number(item.ceiling) <= 32759);
    if (sector < 0) throw new Error(`No safe ordinary sector found for ${map} smoke edit`);
    edits.push({
      type: 'set_sector_heights',
      map,
      sector,
      ceiling: Number(geometry.sectors[sector].ceiling) + 8
    });
  }
  return edits;
}

async function buildExperimentCandidate({ maps, edits, autoEditProfile, filename }) {
  const sourceBytes = await readFile(SOURCE_PATH);
  const workspace = new EpisodeWorkspace(sourceBytes, maps, path.basename(SOURCE_PATH));
  const appliedEdits = [
    ...(autoEditProfile === 'safe-height-nudge' ? createSafeHeightNudgeEdits(workspace) : []),
    ...(Array.isArray(edits) ? edits : [])
  ];
  let transaction = null;

  if (appliedEdits.length) {
    transaction = workspace.beginTransaction(`automated episode experiment: ${autoEditProfile || 'custom'}`);
    try {
      workspace.applyEdits(appliedEdits);
      const validation = workspace.validate({ touchedOnly: true });
      if (!validation.ok) {
        workspace.rollbackTransaction();
        throw new Error(`Experiment transaction validation failed: ${JSON.stringify(validation.maps)}`);
      }
      const commit = workspace.commitTransaction();
      if (!commit.committed) {
        workspace.rollbackTransaction();
        throw new Error(`Experiment transaction could not commit: ${JSON.stringify(commit.validation)}`);
      }
      transaction = commit.transaction;
    } catch (error) {
      if (workspace.transaction) {
        try { workspace.rollbackTransaction(); } catch {}
      }
      throw error;
    }
  }

  const episodeValidation = workspace.validate();
  if (!episodeValidation.ok) throw new Error(`Experiment episode validation failed: ${JSON.stringify(episodeValidation.maps)}`);
  const candidate = await workspace.build({ filename });
  await mkdir(EXPORT_DIR, { recursive: true });
  await writeFile(exportPath(filename), candidate.bytes);
  return {
    filename,
    path: exportPath(filename),
    bytes: candidate.bytes.length,
    maps: workspace.mapNames,
    validation: episodeValidation,
    transaction,
    appliedEdits,
    candidate
  };
}

async function resolveCandidate({ maps, candidateFilename, edits, autoEditProfile, filename }) {
  if (candidateFilename) {
    if ((edits?.length || 0) > 0 || autoEditProfile !== 'none') {
      throw new Error('candidateFilename cannot be combined with edits or autoEditProfile');
    }
    const safe = safeFilename(candidateFilename, candidateFilename);
    const candidatePath = exportPath(safe);
    const bytes = await readFile(candidatePath);
    const markers = inspectMapMarkers(bytes);
    const missing = maps.filter(map => !markers.includes(map));
    if (missing.length) throw new Error(`Candidate ${safe} is missing requested maps: ${missing.join(', ')}`);
    return { filename: safe, path: candidatePath, bytes: bytes.length, maps, reused: true, mapMarkers: markers };
  }

  const safe = safeFilename(filename, `p0-episode-experiment-${Date.now()}.wad`);
  return { ...(await buildExperimentCandidate({ maps, edits, autoEditProfile, filename: safe })), reused: false };
}

async function runExperiment(args) {
  const maps = (args.maps?.length ? args.maps : DEFAULT_EPISODE_MAPS).map(normalizeMapName);
  const id = experimentId();
  const reportDir = path.join(EXPERIMENT_DIR, id);
  await mkdir(reportDir, { recursive: true });

  const candidate = await resolveCandidate({
    maps,
    candidateFilename: args.candidateFilename,
    edits: args.edits || [],
    autoEditProfile: args.autoEditProfile || 'none',
    filename: args.filename
  });

  const configPath = path.join(reportDir, 'config.json');
  const config = {
    experimentId: id,
    filename: candidate.filename,
    wadPath: candidate.path,
    reportDir,
    maps,
    smokeTics: args.smokeTics ?? 35,
    captureFrames: args.captureFrames !== false,
    stopOnFailure: Boolean(args.stopOnFailure),
    actionsByMap: args.actionsByMap || {},
    expectationsByMap: args.expectationsByMap || {},
    playUrl: `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  let child;
  try {
    child = await execFileAsync(process.execPath, [RUNNER_PATH, configPath], {
      cwd: MODULE_DIR,
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    throw new Error(`Episode browser experiment failed to execute${stderr ? `: ${stderr}` : `: ${error?.message || error}`}`);
  }

  const reportPath = path.join(reportDir, 'report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  return {
    version: VERSION,
    experimentId: id,
    passed: Boolean(report.passed),
    candidate: {
      filename: candidate.filename,
      path: candidate.path,
      bytes: candidate.bytes,
      reused: Boolean(candidate.reused),
      appliedEdits: candidate.appliedEdits || []
    },
    summary: report.summary,
    maps: report.results.map(result => ({
      map: result.map,
      passed: Boolean(result.passed),
      failures: result.failures || [],
      error: result.error || null,
      executedTics: result.executedTics ?? null,
      state: result.state || null,
      telemetry: result.telemetry || null,
      screenshot: result.frame?.screenshot || null
    })),
    reportPath,
    reportDir,
    runner: { stdout: String(child.stdout || '').trim(), diagnostics: report.browserDiagnostics || [] }
  };
}

const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const genericEdit = z.record(z.string(), z.unknown());
const action = z.object({
  forward: z.number().min(-1).max(1).optional(),
  strafe: z.number().min(-1).max(1).optional(),
  turn: z.number().min(-1).max(1).optional(),
  attack: z.boolean().optional(),
  use: z.boolean().optional(),
  tics: z.number().int().min(1).max(350)
});
const expectation = z.object({
  maxDeaths: z.number().int().min(0).optional(),
  minHealth: z.number().min(0).optional(),
  minDistanceUnits: z.number().min(0).optional(),
  minVisitedSectors: z.number().min(0).optional()
});

export function createMcpServer() {
  const server = p0Module.createMcpServer();

  server.registerTool('doom_run_episode_experiment', {
    title: 'Run automated multi-map DOOM experiment',
    description: 'One-call P0 regression runner: optionally build a transactional multi-map candidate, cold-boot it in a dedicated headless Chromium, warp through every requested map, run exact-tic action plans, capture PNG evidence and write a PASS/FAIL JSON report. Defaults to E1M1-E1M8. Use candidateFilename to regression-test an already built episode PWAD.',
    inputSchema: z.object({
      maps: z.array(mapName).min(1).max(32).optional(),
      candidateFilename: z.string().min(1).max(120).optional(),
      filename: z.string().min(1).max(120).optional(),
      edits: z.array(genericEdit).max(128).optional(),
      autoEditProfile: z.enum(['none', 'safe-height-nudge']).optional(),
      smokeTics: z.number().int().min(1).max(350).optional(),
      captureFrames: z.boolean().optional(),
      stopOnFailure: z.boolean().optional(),
      actionsByMap: z.record(z.string(), z.array(action).min(1).max(16)).optional(),
      expectationsByMap: z.record(z.string(), expectation).optional()
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async args => {
    try { return jsonResult(await runExperiment(args)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_episode_experiment_report', {
    title: 'Read an automated DOOM episode experiment report',
    description: 'Read the full saved JSON report for a prior automated episode experiment.',
    inputSchema: z.object({ experimentId: z.string().regex(/^episode-exp-[0-9]+-[0-9]{3}$/) }),
    annotations: { readOnlyHint: true }
  }, async ({ experimentId }) => {
    try {
      const reportPath = path.join(EXPERIMENT_DIR, experimentId, 'report.json');
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      return jsonResult({ reportPath, report });
    } catch (error) { return toolError(error); }
  });

  return server;
}

function isDirectExecution() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  startAuthoringBridge();
  startPlaytestBridge();
  startOrchestrationBridge();
  startCheatBridge();
  geometryModule.startGeometryBridge();
  void serveStdio(createMcpServer);
  console.error(`DOOM MCP ${VERSION}: P0 episode authoring + automated experiment runner ready`);
}
