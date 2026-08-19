import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { buildNavigationGraph, findExitProgression, findSectorPath, NAVIGATION_VERSION, reachableSectors } from './navigation_graph.js';
import { runNavigationBrowserTrial } from './navigation_browser_agent.mjs';

const p1Module = await import('./p1_server.js');
const p0Module = await import('./p0_server.js');
const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const geometryModule = await import('./geometry_server.js');

const VERSION = '2.4.0-p1.3';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const NAV_REPORT_DIR = path.join(EXPORT_DIR, 'navigation');
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const keyName = z.enum(['blue', 'yellow', 'red']);
let trialCounter = 1;

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }
function safeFilename(requested, fallback) {
  const raw = String(requested || fallback).trim() || fallback;
  if (raw !== path.basename(raw)) throw new Error('Navigation candidate filename must not contain a path');
  const withExt = raw.toLowerCase().endsWith('.wad') ? raw : `${raw}.wad`;
  const safe = withExt.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!safe || safe !== withExt) throw new Error('Navigation candidate filename contains unsupported characters');
  return safe;
}
function getMapWorkspace(sessionId, requestedMap) {
  const session = p0Module.getEpisodeSession(sessionId);
  const map = String(requestedMap || '').toUpperCase();
  const workspace = session.workspace.workspaces.get(map);
  if (!workspace) throw new Error(`Map ${map} is not part of episode session ${sessionId}`);
  return { session, workspace, map };
}
function defaultStartSector(graph) {
  const start = graph.things.starts.find(item => item.doomEdNum === 1 && item.sector != null);
  if (!start) throw new Error('Map has no locatable Player 1 start; provide startSector explicitly');
  return start.sector;
}
function compactGraph(graph, includeBlocked) {
  return {
    version: graph.version,
    map: graph.map,
    constraints: graph.constraints,
    summary: graph.summary,
    nodes: graph.nodes,
    edges: includeBlocked ? graph.edges : graph.edges.filter(edge => edge.passable),
    things: graph.things,
    exits: graph.exits
  };
}

export function createMcpServer() {
  const server = p1Module.createMcpServer();

  server.registerTool('doom_p1_navigation_status', {
    title: 'Read DOOM P1.3 navigation status',
    description: 'Read the P1.3 sector navigation graph, static planner and deterministic autonomous browser QA capability.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: VERSION,
    navigationVersion: NAVIGATION_VERSION,
    capabilities: ['sector_graph', 'walk_drop_door_lift_classification', 'keyed_path_planning', 'exit_progression', 'autonomous_exact_tic_navigation_trial']
  }));

  server.registerTool('doom_get_navigation_graph', {
    title: 'Build DOOM sector navigation graph',
    description: 'Build a deterministic navigation graph from current authored geometry. Nodes are sectors; directed portal edges classify walk/drop/manual-door/lift/blocked transitions and include portal midpoint/action/key metadata.',
    inputSchema: z.object({ sessionId: z.string(), map: mapName, includeBlocked: z.boolean().optional() }),
    annotations: { readOnlyHint: true }
  }, async ({ sessionId, map, includeBlocked }) => {
    try {
      const { workspace } = getMapWorkspace(sessionId, map);
      return jsonResult(compactGraph(buildNavigationGraph(workspace), Boolean(includeBlocked)));
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_find_navigation_path', {
    title: 'Find a static DOOM sector path',
    description: 'Find a weighted sector path while respecting static blocking, Doom 24-unit step-up, 56-unit clearance, manual keyed doors and lift actions. keys declares keys already available to the planner.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      startSector: z.number().int().min(0).max(65534).optional(),
      targetSector: z.number().int().min(0).max(65534),
      keys: z.array(keyName).max(3).optional(),
      allowDrops: z.boolean().optional()
    }), annotations: { readOnlyHint: true }
  }, async ({ sessionId, map, startSector, targetSector, keys, allowDrops }) => {
    try {
      const { workspace } = getMapWorkspace(sessionId, map);
      const graph = buildNavigationGraph(workspace);
      const start = startSector ?? defaultStartSector(graph);
      const pathResult = findSectorPath(graph, start, targetSector, { keys: keys || [], allowDrops: allowDrops !== false });
      return jsonResult({ map: graph.map, ...pathResult });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_analyze_exit_progression', {
    title: 'Analyze sector-level key/exit progression',
    description: 'Search sector+key state space from Player 1 start (or explicit startSector). Entering a sector containing a key makes that key available; manual keyed doors are then unlocked. This is a sector-level reachability proof, not yet an exact item-pickup trajectory.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      startSector: z.number().int().min(0).max(65534).optional(),
      keys: z.array(keyName).max(3).optional(),
      includeSecret: z.boolean().optional(),
      allowDrops: z.boolean().optional()
    }), annotations: { readOnlyHint: true }
  }, async ({ sessionId, map, startSector, keys, includeSecret, allowDrops }) => {
    try {
      const { workspace } = getMapWorkspace(sessionId, map);
      const graph = buildNavigationGraph(workspace);
      const start = startSector ?? defaultStartSector(graph);
      const progression = findExitProgression(graph, start, {
        keys: keys || [], includeSecret: includeSecret !== false, allowDrops: allowDrops !== false
      });
      const reachable = reachableSectors(graph, start, { keys: keys || [], allowDrops: allowDrops !== false });
      return jsonResult({ map: graph.map, startSector: start, reachableSectors: reachable.length, sectorCount: graph.nodes.length, progression });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_run_navigation_trial', {
    title: 'Autonomously navigate to a DOOM sector',
    description: 'Build the current episode candidate, cold-boot it in dedicated Chromium, compute an unkeyed path from the actual runtime start sector to targetSector, then drive the original LinuxDOOM player through portal midpoints with deterministic exact-tic turn/forward/use commands. Produces a JSON report and PNG evidence.',
    inputSchema: z.object({
      sessionId: z.string(), map: mapName,
      targetSector: z.number().int().min(0).max(65534),
      filename: z.string().min(1).max(100).optional(),
      maxTicsPerEdge: z.number().int().min(35).max(350).optional(),
      captureFrame: z.boolean().optional()
    }), annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ sessionId, map, targetSector, filename, maxTicsPerEdge, captureFrame }) => {
    try {
      const { session, workspace, map: normalized } = getMapWorkspace(sessionId, map);
      if (session.workspace.transaction) throw new Error('Commit or rollback the active transaction before running autonomous navigation QA');
      const graph = buildNavigationGraph(workspace);
      if (!graph.nodes[targetSector]) throw new Error(`Unknown target sector ${targetSector}`);
      const safe = safeFilename(filename, `${sessionId}-${normalized}-nav-${Date.now()}.wad`);
      const candidate = await session.workspace.build({ filename: safe });
      await mkdir(EXPORT_DIR, { recursive: true });
      const wadPath = path.join(EXPORT_DIR, safe);
      await writeFile(wadPath, candidate.bytes);
      const trialId = `nav-${Date.now()}-${String(trialCounter++).padStart(3, '0')}`;
      const reportDir = path.join(NAV_REPORT_DIR, trialId);
      const report = await runNavigationBrowserTrial({
        filename: safe,
        wadPath,
        map: normalized,
        graph,
        targetSector,
        reportDir,
        maxTicsPerEdge: maxTicsPerEdge ?? 210,
        captureFrame: captureFrame !== false,
        playUrl: `http://127.0.0.1:${Number(process.env.DOOM_MCP_PORT || 3777)}/`
      });
      return jsonResult({
        version: VERSION,
        trialId,
        passed: report.passed,
        map: normalized,
        startSector: report.startSector,
        targetSector,
        plan: report.plan ? { found: report.plan.found, sectors: report.plan.sectors, cost: report.plan.cost, edges: report.plan.edges?.map(edge => ({ line: edge.line, from: edge.from, to: edge.to, kind: edge.kind, action: edge.action })) } : null,
        edgeResults: report.edgeResults.map(result => ({ passed: result.passed, line: result.edge.line, from: result.edge.from, to: result.edge.to, kind: result.edge.kind, usedTics: result.usedTics, failure: result.failure || null })),
        finalSector: report.finalState?.currentSector ?? null,
        telemetry: report.telemetry || null,
        screenshot: report.screenshot || null,
        reportPath: report.reportPath,
        candidate: { index: candidate.index, filename: safe, bytes: candidate.bytes.length }
      });
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
  console.error(`DOOM MCP ${VERSION}: P1.3 navigation graph + autonomous QA ready`);
}
