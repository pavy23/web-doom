import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';
import * as z from 'zod/v4';

import { startBridge as startAuthoringBridge } from './server.js';
import { bindHttp } from './http_bind.js';
import { createMcpServer as createV09Server, startPlaytestBridge } from './playtest_server.js';
import { evaluateTrial, normalizeGoal, summarizeTrial } from './evaluator.js';
import {
  ORCHESTRATOR_VERSION,
  MAX_SESSION_ITERATIONS,
  MAX_EDITS_PER_ITERATION,
  MAX_ACTIONS_PER_TRIAL,
  MAX_TICS_PER_TRIAL,
  SPAWNABLE_ENEMIES,
  LINEDEF_PRESETS,
  EXPORT_DIR,
  compactChangeset,
  copySavedPwad,
  hasAuthoringChanges,
  readSavedPwad,
  revisionHints,
  safeWadFilename,
  saveBrowserPwad,
  sessionArtifactName
} from './orchestrator.js';

const HOST = '127.0.0.1';
const ORCHESTRATION_PORT = 3779;
const VERSION = ORCHESTRATOR_VERSION;

let orchestrationHttpServer = null;
let orchestrationWss = null;
let browserSocket = null;
let nextRequestId = 1;
let nextSessionId = 1;
let nextTrialId = 1;
const pending = new Map();
const sessions = new Map();

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] };
}

function imageResult(frame, extra = {}) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          captured: true,
          mimeType: frame.mimeType,
          width: frame.width,
          height: frame.height,
          telemetry: frame.telemetry,
          ...extra
        }, null, 2)
      },
      { type: 'image', data: frame.base64, mimeType: frame.mimeType || 'image/png' }
    ]
  };
}

function connected() {
  return browserSocket && browserSocket.readyState === WebSocket.OPEN;
}

function orchestrationCall(method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!connected()) {
      reject(new Error(
        'No DOOM v1 orchestration bridge is connected. Open http://127.0.0.1:3777/, click CLICK TO START, then retry.'
      ));
      return;
    }
    const id = `orchestrator-${Date.now()}-${nextRequestId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DOOM orchestration bridge timed out while calling ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    browserSocket.send(JSON.stringify({ id, method, params }));
  });
}

function settle(message) {
  if (!message?.id || !pending.has(message.id)) return false;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(new Error(message.error || 'Unknown orchestration bridge error'));
  return true;
}

function rejectAll(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

export function startOrchestrationBridge() {
  if (orchestrationHttpServer) return orchestrationHttpServer;

  orchestrationHttpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify({
        ok: true,
        version: VERSION,
        browserConnected: Boolean(connected()),
        sessions: sessions.size,
        exportDir: EXPORT_DIR
      });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('DOOM v1 orchestration bridge');
  });

  orchestrationWss = new WebSocketServer({ noServer: true });
  orchestrationHttpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url || '/', `http://${HOST}:${ORCHESTRATION_PORT}`).pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/orchestrate') { socket.destroy(); return; }
    orchestrationWss.handleUpgrade(req, socket, head, ws => orchestrationWss.emit('connection', ws, req));
  });

  orchestrationWss.on('connection', ws => {
    if (browserSocket && browserSocket !== ws) {
      try { browserSocket.close(1012, 'Replaced by newer orchestration browser'); } catch {}
    }
    browserSocket = ws;
    console.error('DOOM MCP: v1 orchestration bridge connected');

    ws.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        if (settle(message)) return;
        if (message?.event) console.error(`DOOM MCP: ${message.event}`);
      } catch (error) {
        console.error(`DOOM MCP: bad orchestration message: ${error?.message || error}`);
      }
    });

    ws.on('close', () => {
      if (browserSocket === ws) browserSocket = null;
      rejectAll('DOOM orchestration browser disconnected');
      console.error('DOOM MCP: v1 orchestration bridge disconnected');
    });
  });

  bindHttp(orchestrationHttpServer, {
    host: HOST,
    port: ORCHESTRATION_PORT,
    label: `v1 orchestration bridge at ws://${HOST}:${ORCHESTRATION_PORT}/orchestrate`
  });
  return orchestrationHttpServer;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForSteps(beforeWorldTics, count) {
  const target = Number(beforeWorldTics || 0) + count;
  const deadline = Date.now() + Math.max(5000, Math.ceil(count / 35 * 1000) + 4000);
  let telemetry = null;
  while (Date.now() < deadline) {
    await sleep(20);
    telemetry = await orchestrationCall('get_playtest_telemetry');
    if (Number(telemetry?.worldTics || 0) >= target && Number(telemetry?.stepBudget || 0) === 0) {
      return telemetry;
    }
  }
  throw new Error(`Timed out waiting for ${count} exact world tics`);
}

async function ensurePaused() {
  let telemetry = await orchestrationCall('get_playtest_telemetry');
  if (!telemetry?.paused) {
    await orchestrationCall('set_playtest_paused', { paused: true });
    telemetry = await orchestrationCall('get_playtest_telemetry');
  }
  return telemetry;
}

function normalizeAction(action) {
  return {
    forward: Number(action.forward || 0),
    strafe: Number(action.strafe || 0),
    turn: Number(action.turn || 0),
    attack: Boolean(action.attack),
    use: Boolean(action.use),
    tics: Math.trunc(action.tics)
  };
}

async function runDeterministicAction(action) {
  const command = normalizeAction(action);
  const before = await ensurePaused();
  const priorAgent = await orchestrationCall('get_agent_input_status');
  if (priorAgent?.active) throw new Error('Another agent input is still active');

  await orchestrationCall('queue_agent_input', command);
  await orchestrationCall('step_playtest_tics', { count: command.tics });
  const after = await waitForSteps(before.worldTics, command.tics);
  const agent = await orchestrationCall('get_agent_input_status');
  if (agent?.active || Number(agent?.remainingTics || 0) !== 0) {
    throw new Error('Agent input did not fully drain with requested world tics');
  }
  return { command, before, after, agent };
}

async function runTrial(actions, goal) {
  const totalTics = actions.reduce((sum, action) => sum + Math.trunc(action.tics), 0);
  if (actions.length > MAX_ACTIONS_PER_TRIAL) throw new Error(`Maximum ${MAX_ACTIONS_PER_TRIAL} actions per trial`);
  if (totalTics > MAX_TICS_PER_TRIAL) throw new Error(`Trial is ${totalTics} tics; maximum is ${MAX_TICS_PER_TRIAL}`);

  await ensurePaused();
  await orchestrationCall('cancel_agent_input');
  await orchestrationCall('reset_playtest_metrics');
  const baseline = await orchestrationCall('get_playtest_telemetry');
  const results = [];

  for (let index = 0; index < actions.length; index++) {
    const result = await runDeterministicAction(actions[index]);
    results.push({ index, ...result });
    if (Number(result.after?.deaths || 0) > Number(result.before?.deaths || 0)
        || Number(result.after?.health || 0) <= 0) break;
  }

  const final = await orchestrationCall('get_playtest_telemetry');
  const raw = { baseline, final, actions: results };
  const summary = summarizeTrial(raw);
  const evaluation = evaluateTrial({ goal, trial: raw });
  return {
    id: `v1-trial-${String(nextTrialId++).padStart(4, '0')}`,
    createdAt: new Date().toISOString(),
    raw,
    summary,
    evaluation,
    visualAssessment: {},
    requestedActions: actions.length,
    executedActions: results.length,
    totalRequestedTics: totalTics
  };
}

async function applyEdit(edit) {
  switch (edit.type) {
    case 'sector_light':
      return orchestrationCall('author_set_sector_light', { sector: edit.sector, light: edit.light });
    case 'spawn_enemy':
      return orchestrationCall('author_spawn_enemy', {
        name: edit.enemy,
        count: edit.count ?? 1,
        distance: edit.distance ?? 160
      });
    case 'remove_nearest_enemy': {
      const result = await orchestrationCall('author_remove_nearest_enemy', {
        visibleOnly: Boolean(edit.visibleOnly),
        maxDistance: edit.maxDistance ?? 2048
      });
      if (result?.error) throw new Error(result.error);
      return result;
    }
    case 'linedef_action': {
      const result = await orchestrationCall('author_set_linedef_action', {
        index: edit.index,
        preset: edit.preset,
        tag: edit.tag ?? -1
      });
      if (!result?.updated) throw new Error(result?.error || 'Linedef edit was rejected');
      return result;
    }
    case 'wall_texture': {
      const result = await orchestrationCall('author_set_wall_texture', {
        line: edit.line,
        side: edit.side,
        slot: edit.slot,
        texture: edit.texture
      });
      if (!result?.updated) throw new Error(result?.error || 'Wall texture edit was rejected');
      return result;
    }
    case 'sector_flat': {
      const result = await orchestrationCall('author_set_sector_flat', {
        sector: edit.sector,
        surface: edit.surface,
        flat: edit.flat
      });
      if (!result?.updated) throw new Error(result?.error || 'Sector flat edit was rejected');
      return result;
    }
    default:
      throw new Error(`Unsupported authoring edit: ${edit.type}`);
  }
}

async function applyEdits(edits) {
  if (edits.length > MAX_EDITS_PER_ITERATION) {
    throw new Error(`Maximum ${MAX_EDITS_PER_ITERATION} authoring edits per iteration`);
  }
  const results = [];
  for (let index = 0; index < edits.length; index++) {
    results.push({ index, edit: edits[index], result: await applyEdit(edits[index]) });
  }
  return results;
}

async function checkpointAndLoad(filename) {
  const exported = await orchestrationCall('author_export_pwad', { filename }, 15000);
  const saved = await saveBrowserPwad(filename, exported);
  const loaded = await orchestrationCall('author_load_pwad', {
    filename: saved.filename,
    base64: exported.base64
  }, 20000);
  const changeset = await orchestrationCall('author_get_changeset');
  if (hasAuthoringChanges(changeset)) {
    throw new Error('Candidate reload did not reset the authoring ChangeSet');
  }
  await ensurePaused();
  return { saved, loaded, changeset };
}

async function loadSavedCandidate(filename) {
  const saved = await readSavedPwad(filename);
  const loaded = await orchestrationCall('author_load_pwad', {
    filename: saved.filename,
    base64: saved.bytes.toString('base64')
  }, 20000);
  const changeset = await orchestrationCall('author_get_changeset');
  if (hasAuthoringChanges(changeset)) throw new Error('Restored candidate left authoring changes pending');
  await ensurePaused();
  return { saved: { filename: saved.filename, path: saved.path, bytes: saved.bytes.length, inspection: saved.inspection }, loaded };
}

function findSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown design session: ${sessionId}`);
  return session;
}

function findIteration(session, iterationNumber) {
  const iteration = session.iterations.find(item => item.number === iterationNumber);
  if (!iteration) throw new Error(`Unknown iteration ${iterationNumber} in ${session.id}`);
  return iteration;
}

function liveIterationEvaluation(iteration) {
  return iteration?.trial?.evaluation || null;
}

function sessionView(session) {
  return {
    id: session.id,
    version: VERSION,
    status: session.status,
    createdAt: session.createdAt,
    completedAt: session.completedAt || null,
    goal: session.goal,
    maxIterations: session.maxIterations,
    finalFilename: session.finalFilename,
    baselineFile: session.baselineFile,
    currentArtifact: session.currentArtifact,
    finalArtifact: session.finalArtifact || null,
    iterations: session.iterations.map(item => ({
      number: item.number,
      createdAt: item.createdAt,
      rationale: item.rationale,
      candidateFile: item.candidateFile,
      edits: item.edits,
      appliedEdits: item.appliedEdits,
      adoptedPreexistingChanges: item.adoptedPreexistingChanges,
      preexistingChanges: item.preexistingChanges,
      changes: item.changes,
      trialId: item.trial.id,
      score: item.trial.evaluation.score,
      passed: item.trial.evaluation.passed,
      evaluation: item.trial.evaluation,
      revisionHints: revisionHints(item.trial.evaluation)
    }))
  };
}

const actionShape = z.object({
  forward: z.number().min(-1).max(1).optional(),
  strafe: z.number().min(-1).max(1).optional(),
  turn: z.number().min(-1).max(1).optional(),
  attack: z.boolean().optional(),
  use: z.boolean().optional(),
  tics: z.number().int().min(1).max(350)
});

const goalShape = z.object({
  name: z.string().max(96).optional(),
  description: z.string().max(1000).optional(),
  hard: z.object({
    maxDeaths: z.number().min(0).optional(),
    minFinalHealth: z.number().min(0).optional(),
    maxElapsedSeconds: z.number().min(0).optional(),
    minVisitedSectors: z.number().min(0).optional()
  }).optional(),
  targets: z.object({
    maxDamageTaken: z.number().min(0).optional(),
    minVisitedSectors: z.number().min(0).optional(),
    minDistanceUnits: z.number().min(0).optional(),
    maxStuckActions: z.number().min(0).optional(),
    stuckDistanceThreshold: z.number().min(0).optional(),
    movementIntentThreshold: z.number().min(0).max(2).optional(),
    minKills: z.number().min(0).optional(),
    maxElapsedSeconds: z.number().min(0).optional(),
    minElapsedSeconds: z.number().min(0).optional(),
    minScore: z.number().min(0).max(1).optional()
  }).optional(),
  weights: z.object({
    survivability: z.number().min(0).optional(),
    traversal: z.number().min(0).optional(),
    combat: z.number().min(0).optional(),
    pacing: z.number().min(0).optional(),
    visual: z.number().min(0).optional()
  }).optional(),
  visualRubric: z.array(z.object({
    id: z.string().min(1).max(48),
    label: z.string().max(120).optional(),
    minScore: z.number().min(0).max(1).optional(),
    weight: z.number().min(0).optional()
  })).max(8).optional()
});

const visualAssessmentShape = z.record(
  z.string(),
  z.union([
    z.number().min(0).max(1),
    z.object({ score: z.number().min(0).max(1), reason: z.string().max(300).optional() })
  ])
);

const editShape = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sector_light'), sector: z.number().int().min(0).max(4095), light: z.number().int().min(0).max(255) }),
  z.object({ type: z.literal('spawn_enemy'), enemy: z.enum(SPAWNABLE_ENEMIES), count: z.number().int().min(1).max(8).optional(), distance: z.number().int().min(64).max(1024).optional() }),
  z.object({ type: z.literal('remove_nearest_enemy'), visibleOnly: z.boolean().optional(), maxDistance: z.number().int().min(0).max(8192).optional() }),
  z.object({ type: z.literal('linedef_action'), index: z.number().int().min(0).max(65535), preset: z.enum(LINEDEF_PRESETS), tag: z.number().int().min(0).max(32767).optional() }),
  z.object({ type: z.literal('wall_texture'), line: z.number().int().min(0).max(65535), side: z.enum(['front', 'back']), slot: z.enum(['top', 'middle', 'bottom']), texture: z.string().min(1).max(8) }),
  z.object({ type: z.literal('sector_flat'), sector: z.number().int().min(0).max(4095), surface: z.enum(['floor', 'ceiling']), flat: z.string().min(1).max(8) })
]);

export function createMcpServer() {
  const server = createV09Server();

  server.registerTool('doom_orchestrator_status', {
    title: 'DOOM v1 authoring orchestrator status',
    description: 'Check the closed-loop v1 orchestration bridge, active design sessions and artifact directory.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: VERSION,
    connected: Boolean(connected()),
    orchestrationPort: ORCHESTRATION_PORT,
    sessionCount: sessions.size,
    exportDir: EXPORT_DIR,
    limits: {
      maxIterations: MAX_SESSION_ITERATIONS,
      maxEditsPerIteration: MAX_EDITS_PER_ITERATION,
      maxActionsPerTrial: MAX_ACTIONS_PER_TRIAL,
      maxTicsPerTrial: MAX_TICS_PER_TRIAL
    }
  }));

  server.registerTool('doom_begin_design_session', {
    title: 'Begin a bounded DOOM design session',
    description: 'Freeze a reproducible baseline PWAD, normalize the design goal and start a bounded closed-loop authoring session.',
    inputSchema: z.object({
      goal: goalShape.optional(),
      maxIterations: z.number().int().min(1).max(MAX_SESSION_ITERATIONS).optional(),
      finalFilename: z.string().min(1).max(120).optional(),
      adoptPendingChanges: z.boolean().optional()
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ goal = {}, maxIterations = 5, finalFilename = 'ai_final.wad', adoptPendingChanges = false }) => {
    try {
      const state = await orchestrationCall('author_get_state');
      if (!state?.ready) throw new Error('DOOM map is not ready for a design session');
      const changeset = await orchestrationCall('author_get_changeset');
      if (hasAuthoringChanges(changeset) && !adoptPendingChanges) {
        throw new Error('Unexported authoring changes are pending. Export them first or begin with adoptPendingChanges=true.');
      }

      const id = `session-${String(nextSessionId++).padStart(4, '0')}`;
      const baselineFile = sessionArtifactName(id, 'baseline');
      const normalizedGoal = normalizeGoal(goal);
      const checkpoint = await checkpointAndLoad(baselineFile);
      const session = {
        id,
        createdAt: new Date().toISOString(),
        status: 'active',
        goal: normalizedGoal,
        maxIterations,
        finalFilename: safeWadFilename(finalFilename),
        baselineFile: checkpoint.saved.filename,
        currentArtifact: checkpoint.saved.filename,
        iterations: []
      };
      sessions.set(id, session);
      return jsonResult({
        session: sessionView(session),
        baseline: {
          state,
          adoptedPendingChanges: Boolean(adoptPendingChanges && hasAuthoringChanges(changeset)),
          originalChanges: compactChangeset(changeset),
          artifact: checkpoint.saved
        }
      });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_run_authoring_iteration', {
    title: 'Run one closed-loop DOOM authoring iteration',
    description: 'Apply up to 12 bounded persistent edits, checkpoint/reload them as a candidate PWAD, run a deterministic trial from the reloaded map, score it and return the final frame.',
    inputSchema: z.object({
      sessionId: z.string().min(1),
      rationale: z.string().max(1000).optional(),
      edits: z.array(editShape).max(MAX_EDITS_PER_ITERATION),
      actions: z.array(actionShape).min(1).max(MAX_ACTIONS_PER_TRIAL),
      adoptPendingChanges: z.boolean().optional()
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, rationale = '', edits, actions, adoptPendingChanges = false }) => {
    try {
      const session = findSession(sessionId);
      if (session.status !== 'active') throw new Error(`Design session is ${session.status}`);
      if (session.iterations.length >= session.maxIterations) {
        throw new Error(`Design session reached its ${session.maxIterations}-iteration limit`);
      }

      const preexistingChanges = await orchestrationCall('author_get_changeset');
      if (hasAuthoringChanges(preexistingChanges) && !adoptPendingChanges) {
        throw new Error('Out-of-band authoring changes are pending. Restore the current session candidate, or retry with adoptPendingChanges=true only if those edits are intentionally part of this iteration.');
      }

      const appliedEdits = await applyEdits(edits);
      const changeset = await orchestrationCall('author_get_changeset');
      const number = session.iterations.length + 1;
      const candidateFile = sessionArtifactName(session.id, 'iteration', number);
      const candidate = await checkpointAndLoad(candidateFile);
      const trial = await runTrial(actions, session.goal);
      const iteration = {
        number,
        createdAt: new Date().toISOString(),
        rationale: String(rationale || '').slice(0, 1000),
        edits,
        appliedEdits,
        adoptedPreexistingChanges: Boolean(adoptPendingChanges && hasAuthoringChanges(preexistingChanges)),
        preexistingChanges: compactChangeset(preexistingChanges),
        changes: compactChangeset(changeset),
        candidateFile: candidate.saved.filename,
        candidate: candidate.saved,
        trial
      };
      session.iterations.push(iteration);
      session.currentArtifact = candidate.saved.filename;
      if (trial.evaluation.passed) session.lastPassingIteration = number;

      const frame = await orchestrationCall('capture_frame', {}, 10000);
      return imageResult(frame, {
        designSession: session.id,
        iteration: number,
        candidate: candidate.saved,
        trial: {
          id: trial.id,
          summary: trial.summary,
          evaluation: trial.evaluation,
          revisionHints: revisionHints(trial.evaluation)
        },
        next: trial.evaluation.passed
          ? 'Candidate passes current goal. Review visual rubric if required, then finalize or continue intentionally.'
          : 'Use the evaluation failures and revisionHints to plan the next bounded iteration.'
      });
    } catch (error) {
      try { await orchestrationCall('cancel_agent_input'); } catch {}
      return toolError(error);
    }
  });

  server.registerTool('doom_review_design_iteration', {
    title: 'Attach AI vision review to a design iteration',
    description: 'Combine visual rubric scores from the returned frame with the iteration telemetry, then update its pass/fail result and revision hints.',
    inputSchema: z.object({
      sessionId: z.string().min(1),
      iteration: z.number().int().min(1),
      visualAssessment: visualAssessmentShape
    }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ sessionId, iteration: iterationNumber, visualAssessment }) => {
    try {
      const session = findSession(sessionId);
      const iteration = findIteration(session, iterationNumber);
      const evaluation = evaluateTrial({
        goal: session.goal,
        trial: iteration.trial.raw,
        visualAssessment
      });
      iteration.trial.visualAssessment = visualAssessment;
      iteration.trial.evaluation = evaluation;
      if (evaluation.passed) session.lastPassingIteration = iteration.number;
      return jsonResult({
        sessionId,
        iteration: iteration.number,
        candidateFile: iteration.candidateFile,
        evaluation,
        revisionHints: revisionHints(evaluation)
      });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_design_session', {
    title: 'Read a DOOM v1 design session',
    description: 'Return the design goal, candidate artifacts, iteration edits, scores and revision hints for one closed-loop authoring session.',
    inputSchema: z.object({ sessionId: z.string().min(1) }),
    annotations: { readOnlyHint: true }
  }, async ({ sessionId }) => {
    try { return jsonResult(sessionView(findSession(sessionId))); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_restore_design_candidate', {
    title: 'Restore a previous DOOM design candidate',
    description: 'Reload the session baseline (iteration 0) or a previous candidate PWAD so the AI can branch from a better iteration.',
    inputSchema: z.object({
      sessionId: z.string().min(1),
      iteration: z.number().int().min(0),
      discardChanges: z.boolean().optional()
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, iteration: iterationNumber, discardChanges = false }) => {
    try {
      const session = findSession(sessionId);
      const pendingChanges = await orchestrationCall('author_get_changeset');
      if (hasAuthoringChanges(pendingChanges) && !discardChanges) {
        throw new Error('Unexported authoring changes are pending. Retry with discardChanges=true only if they may be discarded.');
      }
      const filename = iterationNumber === 0
        ? session.baselineFile
        : findIteration(session, iterationNumber).candidateFile;
      const restored = await loadSavedCandidate(filename);
      session.currentArtifact = filename;
      session.restoredAt = { iteration: iterationNumber, at: new Date().toISOString() };
      return jsonResult({ sessionId, iteration: iterationNumber, artifact: filename, restored });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_finalize_design_session', {
    title: 'Finalize a passing DOOM design candidate',
    description: 'Choose an explicit or best passing candidate, restore it, copy it to the final PWAD filename and close the design session. Non-passing candidates require force=true.',
    inputSchema: z.object({
      sessionId: z.string().min(1),
      iteration: z.number().int().min(1).optional(),
      filename: z.string().min(1).max(120).optional(),
      force: z.boolean().optional(),
      discardChanges: z.boolean().optional()
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ sessionId, iteration: requestedIteration, filename, force = false, discardChanges = false }) => {
    try {
      const session = findSession(sessionId);
      if (!session.iterations.length) throw new Error('Design session has no candidate iterations');

      let chosen;
      if (requestedIteration != null) {
        chosen = findIteration(session, requestedIteration);
      } else {
        const passing = session.iterations.filter(item => liveIterationEvaluation(item)?.passed);
        const pool = passing.length ? passing : (force ? session.iterations : []);
        if (!pool.length) throw new Error('No passing candidate exists. Review/revise another iteration or finalize with force=true.');
        chosen = [...pool].sort((a, b) => Number(b.trial.evaluation.score || 0) - Number(a.trial.evaluation.score || 0))[0];
      }

      if (!chosen.trial.evaluation.passed && !force) {
        throw new Error(`Iteration ${chosen.number} does not pass the design goal (score ${chosen.trial.evaluation.score})`);
      }

      const pendingChanges = await orchestrationCall('author_get_changeset');
      if (hasAuthoringChanges(pendingChanges) && !discardChanges) {
        throw new Error('Unexported authoring changes are pending. Retry with discardChanges=true only if they may be discarded.');
      }

      await loadSavedCandidate(chosen.candidateFile);
      const finalName = safeWadFilename(filename || session.finalFilename);
      const finalArtifact = await copySavedPwad(chosen.candidateFile, finalName);
      session.status = 'completed';
      session.completedAt = new Date().toISOString();
      session.currentArtifact = chosen.candidateFile;
      session.finalArtifact = {
        ...finalArtifact,
        chosenIteration: chosen.number,
        trialId: chosen.trial.id,
        evaluation: chosen.trial.evaluation,
        forced: Boolean(force && !chosen.trial.evaluation.passed)
      };

      return jsonResult({
        completed: true,
        session: sessionView(session),
        finalArtifact: session.finalArtifact
      });
    } catch (error) { return toolError(error); }
  });

  return server;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isDirectExecution()) {
  startAuthoringBridge();
  startPlaytestBridge();
  startOrchestrationBridge();
  void serveStdio(createMcpServer);
  console.error(`DOOM MCP ${VERSION}: closed-loop authoring orchestrator ready`);
}
