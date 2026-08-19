import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { installAutoRepair } from './auto_repair.js';
import { markWorkspaceAsGenerated } from './blank_map.js';
import {
  BOT_SKILL_PRESETS,
  DEATHMATCH_DESIGN_VERSION,
  DEATHMATCH_POLICY_VERSION,
  compareDeathmatchReports,
  createDeathmatchArenaPwad,
  evaluateDeathmatchFairness,
  getDeathmatchPolicy,
  resolveBotSkill
} from './deathmatch_design.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

const p21Module = await import('./p2_game_design_server.js');
const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const geometryModule = await import('./geometry_server.js');

export const P2_DEATHMATCH_SERVER_VERSION = '2.8.0-p2.2';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const botSkill = z.enum(['easy', 'normal', 'hard', 'nightmare']);
const MAX_DM_SESSIONS = 6;
let nextSession = 1;
const sessions = new Map();

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }
function safeFilename(value, fallback = 'p2-deathmatch.wad') {
  const raw = String(value || fallback).trim() || fallback;
  if (raw !== path.basename(raw)) throw new Error('filename must be inside the MCP export directory');
  const withExt = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  if (!/^[A-Za-z0-9._-]+\.wad$/i.test(withExt)) throw new Error('filename must be a safe .wad filename');
  return withExt;
}
function markEpisodeGenerated(episode) {
  for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
  for (const workspace of episode.baselines.values()) markWorkspaceAsGenerated(workspace);
  return episode;
}
function sessionView(session) {
  return { id: session.id, map: session.map, createdAt: session.createdAt, arena: session.arena, ...session.episode.summary() };
}
function getSession(id) {
  const session = sessions.get(String(id));
  if (!session) throw new Error(`Unknown P2.2 deathmatch session ${id}`);
  return session;
}
function getWorkspace(session) {
  const workspace = session.episode.workspaces.get(session.map);
  if (!workspace) throw new Error(`Session ${session.id} lost map ${session.map}`);
  return workspace;
}
async function buildSession(session, filename) {
  const safe = safeFilename(filename, `${session.id}-${session.map}.wad`);
  const candidate = await session.episode.build({ filename: safe });
  await mkdir(EXPORT_DIR, { recursive: true });
  const wadPath = path.join(EXPORT_DIR, safe);
  await writeFile(wadPath, candidate.bytes);
  session.lastBuild = { filename: safe, wadPath, bytes: candidate.bytes.length, builtAt: new Date().toISOString() };
  return { safe, wadPath, candidate };
}
async function loadCandidate(filename, map) {
  const safe = safeFilename(filename);
  const bytes = await readFile(path.join(EXPORT_DIR, safe));
  return { safe, bytes, workspace: new GeometryWorkspace(bytes, String(map).toUpperCase()) };
}

export function createDeathmatchSession(input = {}) {
  if (sessions.size >= MAX_DM_SESSIONS) throw new Error(`P2.2 deathmatch session limit ${MAX_DM_SESSIONS} reached`);
  const generated = createDeathmatchArenaPwad(input);
  const episode = markEpisodeGenerated(new EpisodeWorkspace(generated.bytes, [generated.map], `generated-deathmatch:${generated.map}`));
  const id = `dm-${String(nextSession++).padStart(4, '0')}`;
  const session = { id, map: generated.map, arena: generated.arena, sourceBytes: generated.bytes, episode, createdAt: new Date().toISOString(), lastBuild: null };
  sessions.set(id, session);
  return sessionView(session);
}

export function createMcpServer() {
  const server = p21Module.createMcpServer();

  server.registerTool('doom_p2_deathmatch_status', {
    title: 'Read P2.2 deathmatch generation status',
    description: 'Read source-free deathmatch generation, fairness evaluation and local-bot policy capabilities.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: P2_DEATHMATCH_SERVER_VERSION,
    designVersion: DEATHMATCH_DESIGN_VERSION,
    policyVersion: DEATHMATCH_POLICY_VERSION,
    sessions: [...sessions.values()].map(sessionView),
    capabilities: [
      'source_free_deathmatch_arena_generation',
      'four_player_and_eight_dm_spawn_seed',
      'spawn_distance_and_los_fairness',
      'spawn_to_weapon_equity',
      'high_value_item_contest_equity',
      'route_choice_and_loop_scoring',
      'deterministic_bot_skill_profiles',
      'local_bot_runtime_in_progress'
    ],
    botSkills: Object.keys(BOT_SKILL_PRESETS),
    boundary: 'P2.2 local bots run inside one LinuxDOOM browser process. Remote human networking remains P3.0.'
  }));

  server.registerTool('doom_get_deathmatch_policy', {
    title: 'Read P2.2 deathmatch fairness and bot policy',
    description: 'Return deterministic fairness targets, score weights and built-in bot skill presets.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult(getDeathmatchPolicy()));

  server.registerTool('doom_get_bot_skill_profiles', {
    title: 'Read local deathmatch bot skill profiles',
    description: 'Return easy/normal/hard/nightmare deterministic bot behavior parameters.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({ profiles: BOT_SKILL_PRESETS }));

  server.registerTool('doom_resolve_bot_skill', {
    title: 'Resolve a bot skill profile',
    description: 'Resolve a named bot difficulty into concrete reaction, aim, movement, aggression, item-bias and dodge parameters.',
    inputSchema: z.object({ skill: botSkill }), annotations: { readOnlyHint: true }
  }, async input => jsonResult(resolveBotSkill(input.skill)));

  server.registerTool('doom_create_deathmatch_arena', {
    title: 'Generate and build a source-free deathmatch arena',
    description: 'Create a symmetric octagonal-ring deathmatch map with 8 deathmatch starts, 4 player starts, distributed weapons/resources and a contested center power position; validate and build it through the P0/ZDBSP pipeline.',
    inputSchema: z.object({
      map: mapName.optional(),
      outerRadius: z.number().int().min(384).max(1400).optional(),
      innerRadius: z.number().int().min(128).max(900).optional(),
      floor: z.number().int().min(-4096).max(4096).optional(),
      ceiling: z.number().int().min(-4096).max(8192).optional(),
      light: z.number().int().min(0).max(255).optional(),
      filename: z.string().min(5).max(120).optional()
    }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async input => {
    try {
      const view = createDeathmatchSession(input);
      const session = getSession(view.id);
      const validation = session.episode.validate();
      if (!validation.ok) throw new Error(`Generated deathmatch map failed deterministic validation: ${JSON.stringify(validation.errors || validation)}`);
      const built = await buildSession(session, input.filename);
      const fairness = evaluateDeathmatchFairness(getWorkspace(session));
      return jsonResult({ session: sessionView(session), validation, build: { filename: built.safe, path: built.wadPath, bytes: built.candidate.bytes.length }, fairness });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_deathmatch_session', {
    title: 'Inspect a P2.2 deathmatch session',
    description: 'Read current session summary, last build and deterministic fairness report.',
    inputSchema: z.object({ sessionId: z.string().min(1) }), annotations: { readOnlyHint: true }
  }, async input => {
    try {
      const session = getSession(input.sessionId);
      return jsonResult({ session: sessionView(session), lastBuild: session.lastBuild, fairness: evaluateDeathmatchFairness(getWorkspace(session)) });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_evaluate_deathmatch_fairness', {
    title: 'Evaluate an exported deathmatch candidate',
    description: 'Score spawn distance, weapon equity, route choice, initial LOS exposure, high-value pickup equity and topology for an exported PWAD.',
    inputSchema: z.object({ filename: z.string().min(5).max(120), map: mapName }), annotations: { readOnlyHint: true, openWorldHint: false }
  }, async input => {
    try {
      const loaded = await loadCandidate(input.filename, input.map);
      return jsonResult({ filename: loaded.safe, bytes: loaded.bytes.length, ...evaluateDeathmatchFairness(loaded.workspace) });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_compare_deathmatch_fairness', {
    title: 'Compare two exported deathmatch candidates',
    description: 'Evaluate before/after deathmatch candidates under the exact same P2.2 fairness policy and report score/issue deltas.',
    inputSchema: z.object({ beforeFilename: z.string().min(5).max(120), afterFilename: z.string().min(5).max(120), map: mapName }), annotations: { readOnlyHint: true, openWorldHint: false }
  }, async input => {
    try {
      const before = await loadCandidate(input.beforeFilename, input.map);
      const after = await loadCandidate(input.afterFilename, input.map);
      const beforeReport = evaluateDeathmatchFairness(before.workspace);
      const afterReport = evaluateDeathmatchFairness(after.workspace);
      return jsonResult({ beforeFilename: before.safe, afterFilename: after.safe, comparison: compareDeathmatchReports(beforeReport, afterReport), before: beforeReport, after: afterReport });
    } catch (error) { return toolError(error); }
  });

  return server;
}

function isDirectExecution() { return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url; }
if (isDirectExecution()) {
  startAuthoringBridge();
  startPlaytestBridge();
  startOrchestrationBridge();
  startCheatBridge();
  geometryModule.startGeometryBridge();
  void serveStdio(createMcpServer);
  console.error(`DOOM MCP ${P2_DEATHMATCH_SERVER_VERSION}: P2.2 deathmatch generation/fairness ready`);
}
