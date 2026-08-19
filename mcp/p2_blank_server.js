import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { GeometryWorkspace } from './geometry.js';
import { EpisodeWorkspace } from './episode_workspace.js';
import { installFullTopologyValidator } from './topology_validator.js';
import { installThingAuthoring } from './thing_authoring.js';
import { installSemanticGeometry } from './semantic_geometry.js';
import { AUTO_REPAIR_VERSION, diagnoseNavigation, installAutoRepair, planAutoRepairs } from './auto_repair.js';
import { applyRepairPlan } from './auto_repair_episode.js';
import { buildNavigationGraph } from './navigation_graph.js';
import { runNavigationBrowserTrial } from './navigation_browser_agent.mjs';
import { BLANK_MAP_VERSION, createSeededBlankMapPwad, markWorkspaceAsGenerated } from './blank_map.js';

installFullTopologyValidator(GeometryWorkspace);
installThingAuthoring(GeometryWorkspace);
installSemanticGeometry(GeometryWorkspace);
installAutoRepair(GeometryWorkspace);

const p1Module = await import('./p1_auto_repair_server.js');
const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const geometryModule = await import('./geometry_server.js');

export const P2_BLANK_SERVER_VERSION = '2.6.0-p2.0';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const REPORT_DIR = path.join(EXPORT_DIR, 'p2-blank');
const MAX_BLANK_SESSIONS = 6;
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const genericEdit = z.record(z.string(), z.unknown());
const keyName = z.enum(['blue', 'yellow', 'red']);

let nextBlankSessionId = 1;
let nextTrialId = 1;
const blankSessions = new Map();

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }

function safeFilename(requested, fallback = 'p2-blank-map.wad') {
  const raw = String(requested || fallback).trim() || fallback;
  if (raw !== path.basename(raw)) throw new Error('Blank-map filename must not contain a path');
  const withExt = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = withExt.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!safe || safe !== withExt) throw new Error('Blank-map filename contains unsupported characters');
  return safe;
}

function getBlankSession(id) {
  const session = blankSessions.get(String(id));
  if (!session) throw new Error(`Unknown P2 blank-map session ${id}`);
  return session;
}

function mapWorkspace(session, requestedMap = null) {
  const map = String(requestedMap || session.map).toUpperCase();
  const workspace = session.workspace.workspaces.get(map);
  if (!workspace) throw new Error(`Map ${map} is not part of blank-map session ${session.id}`);
  return { map, workspace };
}

function markEpisodeAsGenerated(episode) {
  for (const workspace of episode.workspaces.values()) markWorkspaceAsGenerated(workspace);
  for (const baseline of episode.baselines.values()) markWorkspaceAsGenerated(baseline);
  return episode;
}

function sessionView(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    map: session.map,
    seed: session.seed,
    generatedFromLegacyMap: false,
    ...session.workspace.summary()
  };
}

export function createBlankSession(input = {}) {
  if (blankSessions.size >= MAX_BLANK_SESSIONS) throw new Error(`P2 blank-map session limit ${MAX_BLANK_SESSIONS} reached; restart the MCP process to clear old sessions`);
  const generated = createSeededBlankMapPwad(input);
  const id = `blank-${String(nextBlankSessionId++).padStart(4, '0')}`;
  const episode = markEpisodeAsGenerated(new EpisodeWorkspace(generated.bytes, [generated.map], `generated:${generated.map}`));
  const session = {
    id,
    map: generated.map,
    seed: generated.seed,
    workspace: episode,
    sourceBytes: generated.bytes,
    createdAt: new Date().toISOString()
  };
  blankSessions.set(id, session);
  return sessionView(session);
}

async function buildBlankCandidate(session, filename) {
  const safe = safeFilename(filename, `${session.id}-${session.map}.wad`);
  const candidate = await session.workspace.build({ filename: safe });
  await mkdir(EXPORT_DIR, { recursive: true });
  const wadPath = path.join(EXPORT_DIR, safe);
  await writeFile(wadPath, candidate.bytes);
  return { safe, wadPath, candidate };
}

function diagnosisOptions(input) {
  return {
    targetSector: input.targetSector,
    keys: input.keys || [],
    includeSecret: input.includeSecret !== false,
    allowDrops: input.allowDrops !== false
  };
}

function repairOptions(input) {
  return {
    ...diagnosisOptions(input),
    allowLegacyGeometry: false,
    allowThingRepair: input.allowThingRepair !== false,
    maxEdits: Math.max(1, Math.min(8, Number(input.maxEdits ?? 4)))
  };
}

export async function runBlankAutoRepair(input) {
  const session = getBlankSession(input.sessionId);
  const { map, workspace } = mapWorkspace(session, input.map);
  const episode = session.workspace;
  if (episode.transaction) throw new Error('Commit or rollback the active P2 transaction before auto-repair');
  const maxIterations = Math.max(1, Math.min(4, Math.trunc(Number(input.maxIterations ?? 3))));
  const iterations = [];
  let diagnosis = null;

  for (let iteration = 0; iteration <= maxIterations; iteration++) {
    diagnosis = diagnoseNavigation(workspace, diagnosisOptions(input));
    if (diagnosis.healthy) break;
    if (iteration === maxIterations) break;
    const plan = planAutoRepairs(workspace, diagnosis, repairOptions(input));
    if (!plan.edits.length) return { passed: false, failure: 'manual_repair_required', map, diagnosis, plan, iterations };
    episode.beginTransaction(`P2 auto-repair ${map} iteration ${iteration + 1}`);
    const applied = applyRepairPlan(episode, plan.edits);
    const validation = episode.validate({ touchedOnly: true });
    if (!validation.ok) {
      episode.rollbackTransaction();
      return { passed: false, failure: 'repair_validation_failed', map, diagnosis, plan, applied, validation, iterations };
    }
    const committed = episode.commitTransaction();
    iterations.push({ iteration: iteration + 1, plan, applied, validation, committed });
  }

  diagnosis = diagnoseNavigation(workspace, diagnosisOptions(input));
  if (!diagnosis.healthy) return { passed: false, failure: 'repair_iteration_limit_reached', map, diagnosis, iterations };

  let runtime = null;
  if (input.runtimeVerify !== false) {
    const targetSector = input.targetSector == null ? diagnosis.progression?.finalSector : Number(input.targetSector);
    if (targetSector == null) return { passed: false, failure: 'no_runtime_target_sector', map, diagnosis, iterations };
    const built = await buildBlankCandidate(session, input.filename);
    const graph = buildNavigationGraph(workspace);
    const trialId = `p2-repair-${String(nextTrialId++).padStart(4, '0')}`;
    runtime = await runNavigationBrowserTrial({
      filename: built.safe,
      wadPath: built.wadPath,
      map,
      graph,
      targetSector,
      keys: input.keys || [],
      reportDir: path.join(REPORT_DIR, trialId),
      maxTicsPerEdge: input.maxTicsPerEdge ?? 280,
      captureFrame: input.captureFrame !== false,
      playUrl: `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`
    });
    if (!runtime.passed) return { passed: false, failure: `runtime_verification_failed:${runtime.failure || 'unknown'}`, map, diagnosis, iterations, runtime };
  }

  return { passed: true, map, diagnosis, iterations, runtime };
}

export function createMcpServer() {
  const server = p1Module.createMcpServer();

  server.registerTool('doom_p2_blank_map_status', {
    title: 'Read DOOM P2.0 blank-map generation status',
    description: 'Read source-free canonical Doom map generation capability and active blank-map sessions.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: P2_BLANK_SERVER_VERSION,
    blankMapVersion: BLANK_MAP_VERSION,
    autoRepairVersion: AUTO_REPAIR_VERSION,
    sessions: [...blankSessions.values()].map(sessionView),
    capabilities: [
      'source_free_canonical_map_marker',
      'seeded_playable_start_room',
      'player1_start_and_exit_seed',
      'all_seed_geometry_marked_ai_authored',
      'p0_atomic_transactions',
      'p1_things_and_semantic_geometry',
      'p1_navigation_and_runtime_qa',
      'p1_auto_repair_on_generated_geometry',
      'pinned_zdbsp_build'
    ]
  }));

  server.registerTool('doom_create_blank_map_session', {
    title: 'Create a new source-free DOOM map session',
    description: 'Generate a canonical E#M# or MAP## map from no legacy map baseline. Seeds one valid rectangular room with Player 1 start and an optional exit, then exposes it through a transactional P2 workspace.',
    inputSchema: z.object({
      map: mapName.optional(),
      width: z.number().int().min(128).max(4096).optional(),
      height: z.number().int().min(128).max(4096).optional(),
      floor: z.number().int().min(-4096).max(4096).optional(),
      ceiling: z.number().int().min(-4096).max(8192).optional(),
      light: z.number().int().min(0).max(255).optional(),
      wallTexture: z.string().min(1).max(8).optional(),
      floorFlat: z.string().min(1).max(8).optional(),
      ceilingFlat: z.string().min(1).max(8).optional(),
      includeExit: z.boolean().optional(),
      exitWall: z.enum(['west', 'north', 'east', 'south']).optional()
    }), annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async input => { try { return jsonResult(createBlankSession(input)); } catch (error) { return toolError(error); } });

  server.registerTool('doom_get_blank_map_session', {
    title: 'Inspect a P2 blank-map session',
    description: 'Read current generated-map revision, candidate history and seed metadata.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { readOnlyHint: true }
  }, async ({ sessionId }) => { try { return jsonResult(sessionView(getBlankSession(sessionId))); } catch (error) { return toolError(error); } });

  server.registerTool('doom_get_blank_map', {
    title: 'Inspect generated DOOM map geometry',
    description: 'Read vertices, linedefs, sectors and THINGS from a generated blank-map session.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName.optional(),
      vertexLimit: z.number().int().min(1).max(4096).optional(),
      lineLimit: z.number().int().min(1).max(4096).optional(),
      sectorLimit: z.number().int().min(1).max(1024).optional(),
      thingLimit: z.number().int().min(1).max(4096).optional()
    }), annotations: { readOnlyHint: true }
  }, async ({ sessionId, map, ...limits }) => {
    try {
      const session = getBlankSession(sessionId);
      const target = String(map || session.map).toUpperCase();
      return jsonResult(session.workspace.inspectMap(target, limits));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_begin_blank_transaction', {
    title: 'Begin atomic generated-map transaction',
    description: 'Snapshot the P2 generated map before a batch of P0/P1 edits.',
    inputSchema: z.object({ sessionId: z.string(), label: z.string().max(160).optional() }),
    annotations: { destructiveHint: false, idempotentHint: false }
  }, async ({ sessionId, label }) => { try { return jsonResult(getBlankSession(sessionId).workspace.beginTransaction(label)); } catch (error) { return toolError(error); } });

  server.registerTool('doom_apply_blank_edits', {
    title: 'Apply edits to generated DOOM map',
    description: 'Apply existing P0/P1 transaction edit types to a generated map, including semantic geometry and THINGS edits.',
    inputSchema: z.object({ sessionId: z.string(), edits: z.array(genericEdit).min(1).max(128) }),
    annotations: { destructiveHint: true, idempotentHint: false }
  }, async ({ sessionId, edits }) => { try { return jsonResult(getBlankSession(sessionId).workspace.applyEdits(edits)); } catch (error) { return toolError(error); } });

  server.registerTool('doom_validate_blank_transaction', {
    title: 'Validate generated-map transaction',
    description: 'Run deterministic topology and THINGS validation on the active P2 transaction.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { readOnlyHint: true }
  }, async ({ sessionId }) => { try { return jsonResult(getBlankSession(sessionId).workspace.validate({ touchedOnly: true })); } catch (error) { return toolError(error); } });

  server.registerTool('doom_commit_blank_transaction', {
    title: 'Commit generated-map transaction',
    description: 'Commit only when every touched generated map passes deterministic validation.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { destructiveHint: true, idempotentHint: false }
  }, async ({ sessionId }) => { try { return jsonResult(getBlankSession(sessionId).workspace.commitTransaction()); } catch (error) { return toolError(error); } });

  server.registerTool('doom_rollback_blank_transaction', {
    title: 'Rollback generated-map transaction',
    description: 'Restore the exact P2 snapshot from transaction start.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { destructiveHint: true }
  }, async ({ sessionId }) => { try { return jsonResult(getBlankSession(sessionId).workspace.rollbackTransaction()); } catch (error) { return toolError(error); } });

  server.registerTool('doom_validate_blank_map', {
    title: 'Validate generated DOOM map',
    description: 'Run the complete installed deterministic validators across the generated map.',
    inputSchema: z.object({ sessionId: z.string() }), annotations: { readOnlyHint: true }
  }, async ({ sessionId }) => { try { return jsonResult(getBlankSession(sessionId).workspace.validate()); } catch (error) { return toolError(error); } });

  server.registerTool('doom_build_blank_level', {
    title: 'Build generated DOOM level',
    description: 'Validate a source-free generated map, rebuild its derived lumps with pinned ZDBSP and export a playable PWAD.',
    inputSchema: z.object({ sessionId: z.string(), filename: z.string().min(1).max(100).optional() }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ sessionId, filename }) => {
    try {
      const session = getBlankSession(sessionId);
      const built = await buildBlankCandidate(session, filename);
      return jsonResult({
        sessionId: session.id,
        map: session.map,
        filename: built.safe,
        bytes: built.candidate.bytes.length,
        candidate: built.candidate.index,
        revision: built.candidate.revision,
        maps: built.candidate.maps
      });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_diagnose_blank_navigation', {
    title: 'Diagnose generated-map navigation',
    description: 'Run P1.4 navigation diagnosis against AI-authored blank-map geometry.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName.optional(),
      targetSector: z.number().int().min(0).max(65534).optional(),
      keys: z.array(keyName).max(3).optional(), includeSecret: z.boolean().optional(), allowDrops: z.boolean().optional()
    }), annotations: { readOnlyHint: true }
  }, async input => {
    try {
      const session = getBlankSession(input.sessionId);
      const { workspace } = mapWorkspace(session, input.map);
      return jsonResult(diagnoseNavigation(workspace, diagnosisOptions(input)));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_run_blank_auto_repair', {
    title: 'Run P2 generated-map auto-repair loop',
    description: 'Diagnose and conservatively repair generated-map navigation, validate atomically, rebuild and optionally verify the repaired path in real LinuxDOOM.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName.optional(),
      targetSector: z.number().int().min(0).max(65534).optional(),
      keys: z.array(keyName).max(3).optional(), includeSecret: z.boolean().optional(), allowDrops: z.boolean().optional(),
      allowThingRepair: z.boolean().optional(), maxEdits: z.number().int().min(1).max(8).optional(),
      maxIterations: z.number().int().min(1).max(4).optional(), runtimeVerify: z.boolean().optional(),
      filename: z.string().min(1).max(100).optional(), maxTicsPerEdge: z.number().int().min(35).max(350).optional(), captureFrame: z.boolean().optional()
    }), annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async input => { try { return jsonResult(await runBlankAutoRepair(input)); } catch (error) { return toolError(error); } });

  server.registerTool('doom_run_blank_navigation_trial', {
    title: 'Run autonomous navigation on generated map',
    description: 'Build the generated map, cold-boot LinuxDOOM and require the autonomous exact-tic agent to reach a target sector.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName.optional(), targetSector: z.number().int().min(0).max(65534),
      keys: z.array(keyName).max(3).optional(), filename: z.string().min(1).max(100).optional(),
      maxTicsPerEdge: z.number().int().min(35).max(350).optional(), captureFrame: z.boolean().optional()
    }), annotations: { readOnlyHint: false, openWorldHint: true }
  }, async input => {
    try {
      const session = getBlankSession(input.sessionId);
      const { map, workspace } = mapWorkspace(session, input.map);
      const built = await buildBlankCandidate(session, input.filename);
      const graph = buildNavigationGraph(workspace);
      const trialId = `p2-nav-${String(nextTrialId++).padStart(4, '0')}`;
      const report = await runNavigationBrowserTrial({
        filename: built.safe,
        wadPath: built.wadPath,
        map,
        graph,
        targetSector: input.targetSector,
        keys: input.keys || [],
        reportDir: path.join(REPORT_DIR, trialId),
        maxTicsPerEdge: input.maxTicsPerEdge ?? 280,
        captureFrame: input.captureFrame !== false,
        playUrl: `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`
      });
      return jsonResult({ trialId, map, candidate: built.candidate.index, filename: built.safe, ...report });
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
  console.error(`DOOM MCP ${P2_BLANK_SERVER_VERSION}: P2.0 source-free blank-map generation ready`);
}
