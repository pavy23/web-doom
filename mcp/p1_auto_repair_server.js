import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { GeometryWorkspace } from './geometry.js';
import { AUTO_REPAIR_VERSION, diagnoseNavigation, installAutoRepair, planAutoRepairs } from './auto_repair.js';
import { applyRepairPlan } from './auto_repair_episode.js';
import { buildNavigationGraph } from './navigation_graph.js';
import { runNavigationBrowserTrial } from './navigation_browser_agent.mjs';

installAutoRepair(GeometryWorkspace);

const navigationModule = await import('./p1_navigation_server.js');
const p0Module = await import('./p0_server.js');
const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const geometryModule = await import('./geometry_server.js');

const VERSION = '2.5.0-p1.4';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const REPAIR_REPORT_DIR = path.join(EXPORT_DIR, 'auto-repair');
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const keyName = z.enum(['blue', 'yellow', 'red']);
let repairCounter = 1;

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }
function safeFilename(requested, fallback) {
  const raw = String(requested || fallback).trim() || fallback;
  if (raw !== path.basename(raw)) throw new Error('Repair candidate filename must not contain a path');
  const withExt = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = withExt.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!safe || safe !== withExt) throw new Error('Repair candidate filename contains unsupported characters');
  return safe;
}
function getMapWorkspace(sessionId, requestedMap) {
  const session = p0Module.getEpisodeSession(sessionId);
  const map = String(requestedMap || '').toUpperCase();
  const workspace = session.workspace.workspaces.get(map);
  if (!workspace) throw new Error(`Map ${map} is not part of episode session ${sessionId}`);
  return { session, episode: session.workspace, workspace, map };
}
function snapshotMap(episode, workspace) {
  return {
    geometry: structuredClone(workspace.geometry),
    originalCounts: structuredClone(workspace.originalCounts),
    history: structuredClone(workspace.history || []),
    createdRooms: structuredClone([...(workspace.createdRooms || new Map()).entries()]),
    nextRoomId: Number(workspace.nextRoomId || 1),
    revision: Number(episode.revision || 0),
    candidateLength: episode.candidates.length
  };
}
function restoreMap(episode, workspace, snapshot) {
  if (episode.transaction) episode.rollbackTransaction();
  workspace.geometry = structuredClone(snapshot.geometry);
  workspace.originalCounts = structuredClone(snapshot.originalCounts);
  workspace.history = structuredClone(snapshot.history);
  workspace.createdRooms = new Map(structuredClone(snapshot.createdRooms));
  workspace.nextRoomId = snapshot.nextRoomId;
  episode.revision = snapshot.revision;
  episode.candidates.splice(snapshot.candidateLength);
}
function diagnosisOptions(input) {
  return {
    targetSector: input.targetSector,
    keys: input.keys || [],
    includeSecret: input.includeSecret !== false,
    allowDrops: input.allowDrops !== false
  };
}
function plannerOptions(input) {
  return {
    ...diagnosisOptions(input),
    allowLegacyGeometry: Boolean(input.allowLegacyGeometry),
    allowThingRepair: input.allowThingRepair !== false,
    maxEdits: input.maxEdits ?? 4
  };
}
async function verifyRuntime({ sessionId, episode, workspace, map, diagnosis, targetSector, filename, maxTicsPerEdge, captureFrame }) {
  const graph = buildNavigationGraph(workspace);
  const runtimeTarget = targetSector == null ? diagnosis.progression?.finalSector : Number(targetSector);
  if (runtimeTarget == null || !graph.nodes[runtimeTarget]) {
    return { attempted: false, passed: false, failure: 'no_runtime_target_sector' };
  }
  const keys = targetSector == null ? (diagnosis.progression?.keys || []) : (diagnosis.reachability?.keys || []);
  const safe = safeFilename(filename, `${sessionId}-${map}-repair-${Date.now()}.wad`);
  const candidate = await episode.build({ filename: safe });
  await mkdir(EXPORT_DIR, { recursive: true });
  const wadPath = path.join(EXPORT_DIR, safe);
  await writeFile(wadPath, candidate.bytes);
  const trialId = `repair-${Date.now()}-${String(repairCounter++).padStart(3, '0')}`;
  const reportDir = path.join(REPAIR_REPORT_DIR, trialId);
  const report = await runNavigationBrowserTrial({
    filename: safe,
    wadPath,
    map,
    graph,
    targetSector: runtimeTarget,
    keys,
    reportDir,
    maxTicsPerEdge: maxTicsPerEdge ?? 280,
    captureFrame: captureFrame !== false,
    playUrl: `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`
  });
  return {
    attempted: true,
    passed: report.passed,
    trialId,
    runtimeTarget,
    keys,
    startSector: report.startSector,
    finalSector: report.finalState?.currentSector ?? null,
    failure: report.failure || null,
    plan: report.plan ? { found: report.plan.found, sectors: report.plan.sectors, cost: report.plan.cost } : null,
    edgeResults: report.edgeResults.map(result => ({
      passed: result.passed,
      line: result.edge.line,
      from: result.edge.from,
      to: result.edge.to,
      kind: result.edge.kind,
      usedTics: result.usedTics,
      failure: result.failure || null
    })),
    telemetry: report.telemetry || null,
    screenshot: report.screenshot || null,
    reportPath: report.reportPath,
    candidate: { index: candidate.index, filename: safe, bytes: candidate.bytes.length }
  };
}

export async function runAutoRepairLoop(input) {
  const { session, episode, workspace, map } = getMapWorkspace(input.sessionId, input.map);
  if (episode.transaction) throw new Error('Commit or rollback the active transaction before running P1.4 auto-repair');
  const maxIterations = Math.max(1, Math.min(4, Math.trunc(Number(input.maxIterations ?? 3))));
  const runtimeVerify = input.runtimeVerify !== false;
  const rollbackOnFailure = input.rollbackOnFailure !== false;
  const original = snapshotMap(episode, workspace);
  const report = {
    version: VERSION,
    repairVersion: AUTO_REPAIR_VERSION,
    map,
    targetSector: input.targetSector ?? null,
    startedAt: new Date().toISOString(),
    passed: false,
    iterations: [],
    runtime: null,
    restoredOnFailure: false
  };

  try {
    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      const diagnosis = diagnoseNavigation(workspace, diagnosisOptions(input));
      if (diagnosis.healthy) {
        report.finalDiagnosis = diagnosis;
        if (runtimeVerify) {
          report.runtime = await verifyRuntime({
            sessionId: input.sessionId,
            episode,
            workspace,
            map,
            diagnosis,
            targetSector: input.targetSector,
            filename: input.filename,
            maxTicsPerEdge: input.maxTicsPerEdge,
            captureFrame: input.captureFrame
          });
          report.passed = Boolean(report.runtime.passed);
          if (!report.passed) report.failure = `runtime_verification_failed:${report.runtime.failure || 'unknown'}`;
        } else {
          report.passed = true;
        }
        break;
      }
      if (iteration === maxIterations) {
        report.finalDiagnosis = diagnosis;
        report.failure = 'repair_iteration_limit_reached';
        break;
      }

      const plan = planAutoRepairs(workspace, diagnosis, plannerOptions(input));
      if (!plan.edits.length) {
        report.finalDiagnosis = diagnosis;
        report.failure = 'manual_repair_required';
        report.manualReasons = plan.rejected;
        break;
      }

      episode.beginTransaction(`P1.4 auto-repair ${map} iteration ${iteration + 1}`);
      const applied = applyRepairPlan(episode, plan.edits);
      const validation = episode.validate({ touchedOnly: true });
      if (!validation.ok) {
        if (episode.transaction) episode.rollbackTransaction();
        report.failure = 'repair_validation_failed';
        report.iterations.push({ iteration: iteration + 1, diagnosis, plan, applied, validation, committed: false });
        break;
      }
      const committed = episode.commitTransaction();
      report.iterations.push({ iteration: iteration + 1, diagnosis, plan, applied, validation, committed: committed.committed, revision: episode.revision });
      if (!committed.committed) {
        report.failure = 'repair_commit_failed';
        break;
      }
    }
  } catch (error) {
    report.failure = `exception:${error?.message || error}`;
    report.exception = String(error?.stack || error);
  }

  if (!report.passed && rollbackOnFailure) {
    restoreMap(episode, workspace, original);
    report.restoredOnFailure = true;
  }
  report.completedAt = new Date().toISOString();
  return report;
}

export function createMcpServer() {
  const server = navigationModule.createMcpServer();

  server.registerTool('doom_p1_auto_repair_status', {
    title: 'Read DOOM P1.4 auto-repair status',
    description: 'Read P1.4 deterministic navigation diagnosis, conservative repair planning and rebuild/replay closed-loop capability.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: VERSION,
    repairVersion: AUTO_REPAIR_VERSION,
    capabilities: [
      'navigation_diagnosis',
      'missing_or_inaccessible_key_repair',
      'authored_portal_blocking_repair',
      'authored_sector_step_clearance_repair',
      'authored_exit_insertion',
      'atomic_repair_transactions',
      'runtime_replay_verification',
      'rollback_on_runtime_failure'
    ]
  }));

  server.registerTool('doom_diagnose_navigation', {
    title: 'Diagnose DOOM navigation failure',
    description: 'Diagnose why Player 1 cannot reach a target sector or any recognized exit. Reports progressive key reachability and frontier blockers without mutating the map.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      targetSector: z.number().int().min(0).max(65534).optional(),
      keys: z.array(keyName).max(3).optional(),
      includeSecret: z.boolean().optional(),
      allowDrops: z.boolean().optional()
    }), annotations: { readOnlyHint: true }
  }, async input => {
    try {
      const { workspace } = getMapWorkspace(input.sessionId, input.map);
      return jsonResult(diagnoseNavigation(workspace, diagnosisOptions(input)));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_plan_auto_repair', {
    title: 'Plan conservative DOOM auto-repair',
    description: 'Create a bounded repair plan for current navigation defects. By default legacy Vanilla geometry is protected; authored geometry and gameplay key placement can be repaired.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      targetSector: z.number().int().min(0).max(65534).optional(),
      keys: z.array(keyName).max(3).optional(),
      includeSecret: z.boolean().optional(), allowDrops: z.boolean().optional(),
      allowLegacyGeometry: z.boolean().optional(), allowThingRepair: z.boolean().optional(),
      maxEdits: z.number().int().min(1).max(8).optional()
    }), annotations: { readOnlyHint: true }
  }, async input => {
    try {
      const { workspace } = getMapWorkspace(input.sessionId, input.map);
      const diagnosis = diagnoseNavigation(workspace, diagnosisOptions(input));
      return jsonResult(planAutoRepairs(workspace, diagnosis, plannerOptions(input)));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_run_auto_repair_loop', {
    title: 'Run DOOM diagnose-repair-rebuild-replay loop',
    description: 'Run up to four conservative auto-repair iterations. Each repair is applied inside the existing P0 atomic transaction model, validated, committed, rebuilt, and optionally replayed in real LinuxDOOM/Chromium. Failed runtime verification restores the pre-repair map by default.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      targetSector: z.number().int().min(0).max(65534).optional(),
      keys: z.array(keyName).max(3).optional(),
      includeSecret: z.boolean().optional(), allowDrops: z.boolean().optional(),
      allowLegacyGeometry: z.boolean().optional(), allowThingRepair: z.boolean().optional(),
      maxEdits: z.number().int().min(1).max(8).optional(),
      maxIterations: z.number().int().min(1).max(4).optional(),
      runtimeVerify: z.boolean().optional(), rollbackOnFailure: z.boolean().optional(),
      filename: z.string().min(1).max(100).optional(),
      maxTicsPerEdge: z.number().int().min(35).max(350).optional(),
      captureFrame: z.boolean().optional()
    }), annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async input => {
    try { return jsonResult(await runAutoRepairLoop(input)); }
    catch (error) { return toolError(error); }
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
  console.error(`DOOM MCP ${VERSION}: P1.4 auto-repair closed loop ready`);
}
