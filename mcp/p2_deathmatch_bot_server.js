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
import { createBalancedDeathmatchArenaPwad } from './deathmatch_factory.js';
import {
  BOT_SKILL_PRESETS,
  DEATHMATCH_DESIGN_VERSION,
  DEATHMATCH_POLICY_VERSION,
  compareDeathmatchReports,
  evaluateDeathmatchFairness,
  getDeathmatchPolicy,
  resolveBotSkill
} from './deathmatch_design.js';
import { runLocalBotDeathmatch } from './deathmatch_bot_runtime.mjs';

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

export const P2_DEATHMATCH_BOT_SERVER_VERSION = '2.8.0-p2.2';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const REPORT_DIR = path.join(EXPORT_DIR, 'p2-deathmatch-bots');
const MAX_SESSIONS = 6;
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const skillName = z.enum(['easy', 'normal', 'hard', 'nightmare']);
const genericEdit = z.record(z.string(), z.unknown());
let nextSession = 1;
let nextTrial = 1;
const sessions = new Map();

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }
function safeFilename(value, fallback = 'p2-deathmatch.wad') {
  const raw = String(value || fallback).trim() || fallback;
  if (raw !== path.basename(raw)) throw new Error('filename must reference a file directly inside the MCP export directory');
  const withExt = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  if (!/^[A-Za-z0-9._-]+\.wad$/i.test(withExt)) throw new Error('filename must be a safe .wad filename');
  return withExt;
}
function markEpisodeGenerated(episode) {
  for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
  for (const workspace of episode.baselines.values()) markWorkspaceAsGenerated(workspace);
  return episode;
}
function getSession(id) {
  const session = sessions.get(String(id));
  if (!session) throw new Error(`Unknown P2.2 deathmatch session ${id}`);
  return session;
}
function workspaceOf(session) {
  const workspace = session.episode.workspaces.get(session.map);
  if (!workspace) throw new Error(`Session ${session.id} lost map ${session.map}`);
  return workspace;
}
function sessionView(session) {
  return {
    id: session.id,
    map: session.map,
    createdAt: session.createdAt,
    arena: session.arena,
    lastBuild: session.lastBuild,
    ...session.episode.summary()
  };
}
async function buildSession(session, filename) {
  const safe = safeFilename(filename, `${session.id}-${session.map}.wad`);
  const validation = session.episode.validate();
  if (!validation.ok) throw new Error(`Deathmatch session validation failed: ${JSON.stringify(validation.errors || validation)}`);
  const candidate = await session.episode.build({ filename: safe });
  await mkdir(EXPORT_DIR, { recursive: true });
  const wadPath = path.join(EXPORT_DIR, safe);
  await writeFile(wadPath, candidate.bytes);
  session.lastBuild = { filename: safe, wadPath, bytes: candidate.bytes.length, builtAt: new Date().toISOString() };
  return { safe, wadPath, candidate, validation };
}
async function loadCandidate(filename, map) {
  const safe = safeFilename(filename);
  const bytes = await readFile(path.join(EXPORT_DIR, safe));
  return { safe, bytes, workspace: new GeometryWorkspace(bytes, String(map).toUpperCase()) };
}

export function createDeathmatchSession(input = {}) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`P2.2 session limit ${MAX_SESSIONS} reached; restart MCP to clear old sessions`);
  const generated = createBalancedDeathmatchArenaPwad(input);
  const id = `dm-${String(nextSession++).padStart(4, '0')}`;
  const episode = markEpisodeGenerated(new EpisodeWorkspace(generated.bytes, [generated.map], `generated-deathmatch:${generated.map}`));
  const session = {
    id,
    map: generated.map,
    arena: generated.arena,
    sourceBytes: generated.bytes,
    episode,
    createdAt: new Date().toISOString(),
    lastBuild: null
  };
  sessions.set(id, session);
  return sessionView(session);
}

export function createMcpServer() {
  const server = p21Module.createMcpServer();

  server.registerTool('doom_p2_deathmatch_status', {
    title: 'Read P2.2 deathmatch + bot status',
    description: 'Read source-free deathmatch generation, deterministic fairness evaluation and single-process local-bot capabilities.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: P2_DEATHMATCH_BOT_SERVER_VERSION,
    designVersion: DEATHMATCH_DESIGN_VERSION,
    policyVersion: DEATHMATCH_POLICY_VERSION,
    sessions: [...sessions.values()].map(sessionView),
    botSkills: BOT_SKILL_PRESETS,
    capabilities: [
      'balanced_source_free_deathmatch_generation',
      'spawn_distance_weapon_access_los_fairness',
      'high_value_item_contest_equity',
      'transactional_deathmatch_iteration',
      'easy_normal_hard_nightmare_bot_profiles',
      'customizable_bot_control_parameters',
      'one_human_plus_three_local_bots',
      'four_local_bots_for_automated_trials',
      'exact_tic_linuxdoom_bot_runtime'
    ],
    boundary: 'P2.2 bots share one browser/LinuxDOOM process and do not use remote networking. Browser-to-browser human multiplayer remains P3.0.'
  }));

  server.registerTool('doom_get_deathmatch_policy', {
    title: 'Read P2.2 fairness and bot policy',
    description: 'Return deathmatch fairness targets, scoring weights and bot skill parameters.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult(getDeathmatchPolicy()));

  server.registerTool('doom_get_bot_skill_profiles', {
    title: 'Read P2.2 bot skill profiles',
    description: 'Return easy, normal, hard and nightmare reaction/aim/movement/aggression/dodge profiles.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({ profiles: BOT_SKILL_PRESETS }));

  server.registerTool('doom_resolve_bot_skill', {
    title: 'Resolve a P2.2 bot skill',
    description: 'Resolve a named difficulty to concrete deterministic control parameters.',
    inputSchema: z.object({ skill: skillName }), annotations: { readOnlyHint: true }
  }, async input => jsonResult(resolveBotSkill(input.skill)));

  server.registerTool('doom_create_deathmatch_arena', {
    title: 'Create a balanced source-free deathmatch arena',
    description: 'Create an octagonal ring + contested center arena with 8 deathmatch starts, 4 player starts, equal basic weapon access and distributed resources.',
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
      const built = await buildSession(session, input.filename);
      const fairness = evaluateDeathmatchFairness(workspaceOf(session));
      return jsonResult({ session: sessionView(session), validation: built.validation, build: { filename: built.safe, path: built.wadPath, bytes: built.candidate.bytes.length }, fairness });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_deathmatch_session', {
    title: 'Inspect a P2.2 deathmatch session',
    description: 'Read session geometry summary, latest build and current fairness report.',
    inputSchema: z.object({ sessionId: z.string().min(1) }), annotations: { readOnlyHint: true }
  }, async input => {
    try {
      const session = getSession(input.sessionId);
      return jsonResult({ session: sessionView(session), fairness: evaluateDeathmatchFairness(workspaceOf(session)) });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_begin_deathmatch_transaction', {
    title: 'Begin an atomic deathmatch edit transaction',
    description: 'Begin a P0-backed transaction for P1.1 THINGS or P1.2 semantic geometry edits on a generated deathmatch session.',
    inputSchema: z.object({ sessionId: z.string().min(1), label: z.string().min(1).max(160).optional() }), annotations: { readOnlyHint: false, destructiveHint: false }
  }, async input => {
    try {
      const session = getSession(input.sessionId);
      return jsonResult(session.episode.beginTransaction(input.label || 'P2.2 deathmatch iteration'));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_apply_deathmatch_edits', {
    title: 'Apply edits to the active deathmatch transaction',
    description: 'Apply ordinary P0/P1 edit objects atomically to a generated deathmatch session.',
    inputSchema: z.object({ sessionId: z.string().min(1), edits: z.array(genericEdit).min(1).max(64) }), annotations: { readOnlyHint: false, destructiveHint: true }
  }, async input => {
    try { return jsonResult(getSession(input.sessionId).episode.applyEdits(input.edits)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_validate_deathmatch_transaction', {
    title: 'Validate the active deathmatch transaction',
    description: 'Run deterministic topology/THINGS validation before committing P2.2 edits.',
    inputSchema: z.object({ sessionId: z.string().min(1) }), annotations: { readOnlyHint: true }
  }, async input => {
    try { return jsonResult(getSession(input.sessionId).episode.validate({ touchedOnly: true })); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_commit_deathmatch_transaction', {
    title: 'Commit the active deathmatch transaction',
    description: 'Commit a validated P2.2 transaction.',
    inputSchema: z.object({ sessionId: z.string().min(1) }), annotations: { readOnlyHint: false, destructiveHint: true }
  }, async input => {
    try { return jsonResult(getSession(input.sessionId).episode.commitTransaction()); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_rollback_deathmatch_transaction', {
    title: 'Rollback the active deathmatch transaction',
    description: 'Restore the entire generated deathmatch session to its pre-transaction state.',
    inputSchema: z.object({ sessionId: z.string().min(1) }), annotations: { readOnlyHint: false, destructiveHint: true }
  }, async input => {
    try { return jsonResult(getSession(input.sessionId).episode.rollbackTransaction()); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_build_deathmatch_level', {
    title: 'Build/export the current deathmatch session',
    description: 'Validate and rebuild generated deathmatch geometry through pinned ZDBSP, then save the PWAD in the MCP export directory.',
    inputSchema: z.object({ sessionId: z.string().min(1), filename: z.string().min(5).max(120).optional() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async input => {
    try {
      const session = getSession(input.sessionId);
      const built = await buildSession(session, input.filename);
      return jsonResult({ session: sessionView(session), validation: built.validation, filename: built.safe, path: built.wadPath, bytes: built.candidate.bytes.length, fairness: evaluateDeathmatchFairness(workspaceOf(session)) });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_evaluate_deathmatch_fairness', {
    title: 'Evaluate an exported deathmatch candidate',
    description: 'Score spawn distance, weapon access, route choice, initial LOS exposure, high-value item equity and topology.',
    inputSchema: z.object({ filename: z.string().min(5).max(120), map: mapName }), annotations: { readOnlyHint: true, openWorldHint: false }
  }, async input => {
    try {
      const loaded = await loadCandidate(input.filename, input.map);
      return jsonResult({ filename: loaded.safe, bytes: loaded.bytes.length, ...evaluateDeathmatchFairness(loaded.workspace) });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_compare_deathmatch_fairness', {
    title: 'Compare two deathmatch candidates',
    description: 'Evaluate before/after PWADs with the exact P2.2 fairness policy and report score plus issue deltas.',
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

  server.registerTool('doom_run_local_bot_deathmatch', {
    title: 'Run a local LinuxDOOM deathmatch with configurable bots',
    description: 'Cold-boot a built P2.2 PWAD into the bot-capable local LinuxDOOM runtime and run either 1 human + 3 bots or a fully automated 4-bot exact-tic match. Bot skill can be chosen per player.',
    inputSchema: z.object({
      sessionId: z.string().min(1),
      filename: z.string().min(5).max(120).optional(),
      mode: z.enum(['human_plus_bots', 'all_bots']).optional(),
      botSkills: z.array(skillName).min(1).max(4).optional(),
      totalTics: z.number().int().min(70).max(5000).optional(),
      captureFrame: z.boolean().optional()
    }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async input => {
    try {
      const session = getSession(input.sessionId);
      if (session.episode.transaction) throw new Error('Commit or rollback the active deathmatch transaction before a bot runtime trial');
      const built = await buildSession(session, input.filename);
      const mode = input.mode || 'human_plus_bots';
      const localPlayers = 4;
      const controlPlayers = mode === 'all_bots' ? [0, 1, 2, 3] : [1, 2, 3];
      const requested = input.botSkills || (mode === 'all_bots' ? ['normal', 'normal', 'normal', 'normal'] : ['normal', 'normal', 'normal']);
      const skills = mode === 'all_bots'
        ? Array.from({ length: 4 }, (_, i) => requested[i] || requested[requested.length - 1] || 'normal')
        : ['human', ...Array.from({ length: 3 }, (_, i) => requested[i] || requested[requested.length - 1] || 'normal')];
      const runtimeSkills = skills.map(skill => skill === 'human' ? 'normal' : skill);
      const trialId = `bot-${String(nextTrial++).padStart(4, '0')}`;
      const runtime = await runLocalBotDeathmatch({
        wadPath: built.wadPath,
        filename: built.safe,
        map: session.map,
        localPlayers,
        botSkills: runtimeSkills,
        controlPlayers,
        totalTics: input.totalTics ?? 700,
        reportDir: path.join(REPORT_DIR, trialId),
        captureFrame: input.captureFrame !== false,
        playUrl: `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`
      });
      return jsonResult({
        session: sessionView(session),
        mode,
        playerSkills: skills,
        fairness: evaluateDeathmatchFairness(workspaceOf(session)),
        runtime
      });
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
  console.error(`DOOM MCP ${P2_DEATHMATCH_BOT_SERVER_VERSION}: P2.2 deathmatch + local bots ready`);
}
