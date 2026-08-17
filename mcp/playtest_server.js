import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';
import * as z from 'zod/v4';

import { createMcpServer as createAuthoringServer, startBridge as startAuthoringBridge } from './server.js';
import { evaluateTrial, normalizeGoal, summarizeTrial } from './evaluator.js';

const HOST = '127.0.0.1';
const PLAYTEST_PORT = 3778;
const VERSION = '0.9.0';
const MAX_TRIAL_HISTORY = 20;

let playtestHttpServer = null;
let playtestWss = null;
let browserSocket = null;
let nextRequestId = 1;
let nextTrialId = 1;
const pending = new Map();
const trialHistory = [];

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(error) {
  return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] };
}

function imageResult(frame, extra = {}) {
  const metadata = {
    captured: true,
    mimeType: frame.mimeType,
    width: frame.width,
    height: frame.height,
    telemetry: frame.telemetry,
    ...extra
  };
  return {
    content: [
      { type: 'text', text: JSON.stringify(metadata, null, 2) },
      { type: 'image', data: frame.base64, mimeType: frame.mimeType || 'image/png' }
    ]
  };
}

function connected() {
  return browserSocket && browserSocket.readyState === WebSocket.OPEN;
}

function playtestCall(method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!connected()) {
      reject(new Error(
        'No DOOM playtest bridge is connected. Open http://127.0.0.1:3777/, click CLICK TO START, then retry.'
      ));
      return;
    }

    const id = `playtest-${Date.now()}-${nextRequestId++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DOOM playtest bridge timed out while calling ${method}`));
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
  else entry.reject(new Error(message.error || 'Unknown playtest bridge error'));
  return true;
}

function rejectAll(reason) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
    pending.delete(id);
  }
}

export function startPlaytestBridge() {
  if (playtestHttpServer) return playtestHttpServer;

  playtestHttpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify({
        ok: true,
        version: VERSION,
        browserConnected: Boolean(connected()),
        trials: trialHistory.length
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('DOOM playtest bridge');
  });

  playtestWss = new WebSocketServer({ noServer: true });
  playtestHttpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url || '/', `http://${HOST}:${PLAYTEST_PORT}`).pathname; }
    catch { socket.destroy(); return; }
    if (pathname !== '/playtest') { socket.destroy(); return; }
    playtestWss.handleUpgrade(req, socket, head, ws => playtestWss.emit('connection', ws, req));
  });

  playtestWss.on('connection', ws => {
    if (browserSocket && browserSocket !== ws) {
      try { browserSocket.close(1012, 'Replaced by newer playtest browser'); } catch {}
    }
    browserSocket = ws;
    console.error('DOOM MCP: playtest/vision/agent/evaluation bridge connected');

    ws.on('message', raw => {
      try {
        const message = JSON.parse(String(raw));
        if (settle(message)) return;
        if (message?.event) console.error(`DOOM MCP: ${message.event}`);
      } catch (error) {
        console.error(`DOOM MCP: bad playtest message: ${error?.message || error}`);
      }
    });

    ws.on('close', () => {
      if (browserSocket === ws) browserSocket = null;
      rejectAll('DOOM playtest browser disconnected');
      console.error('DOOM MCP: playtest/vision/agent/evaluation bridge disconnected');
    });
  });

  playtestHttpServer.listen(PLAYTEST_PORT, HOST, () => {
    console.error(`DOOM MCP: playtest/vision/agent/evaluation bridge at ws://${HOST}:${PLAYTEST_PORT}/playtest`);
  });
  return playtestHttpServer;
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
    telemetry = await playtestCall('get_playtest_telemetry');
    if (Number(telemetry?.worldTics || 0) >= target && Number(telemetry?.stepBudget || 0) === 0) {
      return telemetry;
    }
  }
  throw new Error(`Timed out waiting for ${count} exact world tics`);
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

function normalizedAction(action) {
  return {
    forward: Number(action.forward || 0),
    strafe: Number(action.strafe || 0),
    turn: Number(action.turn || 0),
    attack: Boolean(action.attack),
    use: Boolean(action.use),
    tics: Math.trunc(action.tics)
  };
}

async function ensurePaused() {
  let telemetry = await playtestCall('get_playtest_telemetry');
  if (!telemetry?.paused) {
    await playtestCall('set_playtest_paused', { paused: true });
    telemetry = await playtestCall('get_playtest_telemetry');
  }
  return telemetry;
}

async function runDeterministicAction(action) {
  const command = normalizedAction(action);
  const before = await ensurePaused();
  const priorAgent = await playtestCall('get_agent_input_status');
  if (priorAgent?.active) {
    throw new Error('Another agent input is still active; cancel it before starting a new action');
  }

  await playtestCall('queue_agent_input', command);
  await playtestCall('step_playtest_tics', { count: command.tics });
  const after = await waitForSteps(before.worldTics, command.tics);
  const agent = await playtestCall('get_agent_input_status');
  if (agent?.active || Number(agent?.remainingTics || 0) !== 0) {
    throw new Error('Agent input did not fully drain with the requested world tics');
  }
  return { command, before, after, agent };
}

function telemetrySummary(telemetry) {
  return {
    elapsedSeconds: Number(telemetry?.elapsedSeconds || 0),
    worldTics: Number(telemetry?.worldTics || 0),
    distanceUnits: Number(telemetry?.distanceUnits || 0),
    damageTaken: Number(telemetry?.damageTaken || 0),
    deaths: Number(telemetry?.deaths || 0),
    killDelta: Number(telemetry?.killDelta || 0),
    itemDelta: Number(telemetry?.itemDelta || 0),
    secretDelta: Number(telemetry?.secretDelta || 0),
    visitedSectors: Number(telemetry?.visitedSectors || 0),
    finalHealth: Number(telemetry?.health || 0),
    minHealth: Number(telemetry?.minHealth || 0),
    actions: []
  };
}

function rememberTrial(trial) {
  trialHistory.push(trial);
  while (trialHistory.length > MAX_TRIAL_HISTORY) trialHistory.shift();
  return trial;
}

function findTrial(id) {
  const trial = trialHistory.find(entry => entry.id === id);
  if (!trial) throw new Error(`Unknown design trial: ${id}`);
  return trial;
}

async function runDesignTrial(actions, inputGoal = {}) {
  const totalTics = actions.reduce((sum, action) => sum + Math.trunc(action.tics), 0);
  if (totalTics > 700) throw new Error(`Design trial is ${totalTics} tics; maximum is 700`);

  await ensurePaused();
  await playtestCall('cancel_agent_input');
  await playtestCall('reset_playtest_metrics');
  const baseline = await playtestCall('get_playtest_telemetry');
  const results = [];

  for (let index = 0; index < actions.length; index++) {
    const result = await runDeterministicAction(actions[index]);
    results.push({ index, ...result });
    if (Number(result.after?.deaths || 0) > Number(result.before?.deaths || 0)
        || Number(result.after?.health || 0) <= 0) {
      break;
    }
  }

  const final = await playtestCall('get_playtest_telemetry');
  const rawTrial = { baseline, final, actions: results };
  const summary = summarizeTrial(rawTrial);
  const goal = normalizeGoal(inputGoal);
  const evaluation = evaluateTrial({ goal, trial: rawTrial });
  const id = `trial-${String(nextTrialId++).padStart(4, '0')}`;
  return rememberTrial({
    id,
    createdAt: new Date().toISOString(),
    goal,
    requestedActions: actions.length,
    executedActions: results.length,
    totalRequestedTics: totalTics,
    raw: rawTrial,
    summary,
    evaluation,
    visualAssessment: {}
  });
}

export function createMcpServer() {
  const server = createAuthoringServer();

  server.registerTool('doom_playtest_status', {
    title: 'DOOM AI playtest status',
    description: 'Check the v0.9 playtest/vision/agent/evaluation bridge and stored design-trial count.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: VERSION,
    connected: Boolean(connected()),
    playtestPort: PLAYTEST_PORT,
    trialCount: trialHistory.length
  }));

  server.registerTool('doom_pause_playtest', {
    title: 'Pause DOOM world simulation',
    description: 'Pause P_Ticker world simulation while keeping browser rendering and MCP connectivity alive.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    try {
      await playtestCall('set_playtest_paused', { paused: true });
      return jsonResult(await playtestCall('get_playtest_telemetry'));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_resume_playtest', {
    title: 'Resume DOOM world simulation',
    description: 'Resume normal real-time DOOM world simulation and clear any pending exact-step budget.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    try {
      await playtestCall('cancel_agent_input');
      await playtestCall('set_playtest_paused', { paused: false });
      return jsonResult(await playtestCall('get_playtest_telemetry'));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_step_tics', {
    title: 'Advance exact DOOM world tics',
    description: 'While paused, advance exactly N P_Ticker world tics (35 tics = about one second of DOOM simulation), then return updated telemetry.',
    inputSchema: z.object({ count: z.number().int().min(1).max(350) }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ count }) => {
    try {
      const before = await playtestCall('get_playtest_telemetry');
      if (!before?.paused) throw new Error('Playtest must be paused before exact tic stepping');
      await playtestCall('step_playtest_tics', { count });
      const after = await waitForSteps(before.worldTics, count);
      return jsonResult({ requestedTics: count, before, after });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_get_playtest_telemetry', {
    title: 'Read DOOM playtest telemetry',
    description: 'Read elapsed world tics/time, sectors visited, approximate travel distance, health/damage, deaths, kills/items/secrets and ammunition since the current metric baseline.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try { return jsonResult(await playtestCall('get_playtest_telemetry')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_reset_playtest_metrics', {
    title: 'Reset DOOM playtest telemetry baseline',
    description: 'Start a fresh playtest measurement baseline without changing level content.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async () => {
    try { return jsonResult(await playtestCall('reset_playtest_metrics')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_capture_frame', {
    title: 'Capture current DOOM frame for vision',
    description: 'Capture the final browser canvas as PNG plus matching playtest telemetry. Pause first when a stable deterministic observation is needed.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try {
      const frame = await playtestCall('capture_frame', {}, 10000);
      if (!frame?.base64) throw new Error('Browser did not return a PNG frame');
      return imageResult(frame);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_agent_input_status', {
    title: 'Read autonomous DOOM input status',
    description: 'Read the currently queued bounded ticcmd override, if any.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    try { return jsonResult(await playtestCall('get_agent_input_status')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_cancel_agent_input', {
    title: 'Cancel autonomous DOOM input',
    description: 'Immediately clear any queued AI movement/turn/fire/use command without changing level content.',
    inputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    try { return jsonResult(await playtestCall('cancel_agent_input')); }
    catch (error) { return toolError(error); }
  });

  server.registerTool('doom_run_input', {
    title: 'Run one deterministic DOOM input action',
    description: 'Pause the world if needed, apply bounded movement/turn/attack/use through the original ticcmd path for exactly N world tics, leave the world paused, and optionally return the resulting frame.',
    inputSchema: actionShape.extend({ captureAfter: z.boolean().optional() }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ captureAfter = true, ...action }) => {
    try {
      const result = await runDeterministicAction(action);
      if (!captureAfter) return jsonResult(result);
      const frame = await playtestCall('capture_frame', {}, 10000);
      return imageResult(frame, { autonomousAction: result });
    } catch (error) {
      try { await playtestCall('cancel_agent_input'); } catch {}
      return toolError(error);
    }
  });

  server.registerTool('doom_run_input_sequence', {
    title: 'Run a bounded deterministic DOOM input sequence',
    description: 'Execute up to 16 autonomous ticcmd actions sequentially while paused. Total sequence length is capped at 700 world tics.',
    inputSchema: z.object({ actions: z.array(actionShape).min(1).max(16), captureAfter: z.boolean().optional() }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ actions, captureAfter = true }) => {
    try {
      const totalTics = actions.reduce((sum, action) => sum + Math.trunc(action.tics), 0);
      if (totalTics > 700) throw new Error(`Input sequence is ${totalTics} tics; maximum is 700`);
      await ensurePaused();
      const results = [];
      for (let index = 0; index < actions.length; index++) {
        const result = await runDeterministicAction(actions[index]);
        results.push({ index, ...result });
        if (Number(result.after?.deaths || 0) > Number(result.before?.deaths || 0)
            || Number(result.after?.health || 0) <= 0) {
          break;
        }
      }
      const summary = { requestedActions: actions.length, executedActions: results.length, totalRequestedTics: totalTics, results };
      if (!captureAfter) return jsonResult(summary);
      const frame = await playtestCall('capture_frame', {}, 10000);
      return imageResult(frame, { autonomousSequence: summary });
    } catch (error) {
      try { await playtestCall('cancel_agent_input'); } catch {}
      return toolError(error);
    }
  });

  server.registerTool('doom_evaluate_playtest', {
    title: 'Evaluate a DOOM playtest against a design goal',
    description: 'Score either the current telemetry window or a stored design trial against hard constraints, weighted targets and optional AI-vision rubric scores.',
    inputSchema: z.object({
      goal: goalShape.optional(),
      trialId: z.string().optional(),
      visualAssessment: visualAssessmentShape.optional()
    }),
    annotations: { readOnlyHint: true }
  }, async ({ goal = {}, trialId, visualAssessment = {} }) => {
    try {
      if (trialId) {
        const trial = findTrial(trialId);
        const effectiveGoal = Object.keys(goal).length ? normalizeGoal(goal) : trial.goal;
        const evaluation = evaluateTrial({ goal: effectiveGoal, trial: trial.raw, visualAssessment });
        trial.goal = effectiveGoal;
        trial.visualAssessment = visualAssessment;
        trial.evaluation = evaluation;
        return jsonResult({ trialId, evaluation });
      }
      const telemetry = await playtestCall('get_playtest_telemetry');
      return jsonResult({
        live: true,
        evaluation: evaluateTrial({ goal, trial: telemetrySummary(telemetry), visualAssessment })
      });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_run_design_trial', {
    title: 'Run and score a bounded DOOM design trial',
    description: 'Reset telemetry, execute a bounded autonomous action plan, store all action telemetry, score it against the supplied design goal, and return a final PNG for optional vision scoring.',
    inputSchema: z.object({
      goal: goalShape.optional(),
      actions: z.array(actionShape).min(1).max(16)
    }),
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ goal = {}, actions }) => {
    try {
      const trial = await runDesignTrial(actions, goal);
      const frame = await playtestCall('capture_frame', {}, 10000);
      return imageResult(frame, {
        designTrial: {
          id: trial.id,
          goal: trial.goal,
          requestedActions: trial.requestedActions,
          executedActions: trial.executedActions,
          totalRequestedTics: trial.totalRequestedTics,
          summary: trial.summary,
          evaluation: trial.evaluation
        }
      });
    } catch (error) {
      try { await playtestCall('cancel_agent_input'); } catch {}
      return toolError(error);
    }
  });

  server.registerTool('doom_get_trial_history', {
    title: 'Read recent DOOM design trials',
    description: 'Return recent stored trial goals, scores, pass/fail status and summary metrics without image payloads.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ limit = 10 }) => {
    const items = trialHistory.slice(-limit).reverse().map(trial => ({
      id: trial.id,
      createdAt: trial.createdAt,
      goal: trial.goal,
      score: trial.evaluation?.score,
      passed: trial.evaluation?.passed,
      hardFailures: trial.evaluation?.hardFailures || [],
      targetFailures: trial.evaluation?.targetFailures || [],
      summary: trial.summary
    }));
    return jsonResult({ version: VERSION, trials: items });
  });

  server.registerTool('doom_compare_trials', {
    title: 'Compare DOOM design trials',
    description: 'Compare two to six stored design trials by score and key telemetry to identify the strongest authored iteration.',
    inputSchema: z.object({ trialIds: z.array(z.string()).min(2).max(6) }),
    annotations: { readOnlyHint: true }
  }, async ({ trialIds }) => {
    try {
      const trials = trialIds.map(findTrial).map(trial => ({
        id: trial.id,
        score: Number(trial.evaluation?.score || 0),
        passed: Boolean(trial.evaluation?.passed),
        dimensions: trial.evaluation?.dimensions || {},
        hardFailures: trial.evaluation?.hardFailures || [],
        targetFailures: trial.evaluation?.targetFailures || [],
        summary: trial.summary
      }));
      trials.sort((a, b) => b.score - a.score);
      return jsonResult({ winner: trials[0]?.id || null, ranking: trials });
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
  void serveStdio(createMcpServer);
  console.error(`DOOM MCP ${VERSION}: authoring + autonomous playtest + design evaluation stdio server ready`);
}
