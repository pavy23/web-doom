import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { GeometryWorkspace } from './geometry.js';
import {
  GAME_DESIGN_EVALUATOR_VERSION,
  GAME_DESIGN_POLICY_VERSION,
  compareGameDesignReports,
  evaluateGameDesign,
  getGameDesignPolicy
} from './game_design_evaluator.js';

const p2Module = await import('./p2_blank_server.js');
const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const geometryModule = await import('./geometry_server.js');

export const P2_GAME_DESIGN_SERVER_VERSION = '2.7.0-p2.1';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);
const profileName = z.enum(['balanced', 'combat', 'exploration']);
const skillName = z.enum(['easy', 'medium', 'hard']);

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }

function safeExportFilename(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('filename is required');
  if (raw !== path.basename(raw)) throw new Error('filename must reference a file directly inside the MCP export directory');
  if (!/^[A-Za-z0-9._-]+\.wad$/i.test(raw)) throw new Error('filename must be a safe .wad export filename');
  return raw;
}

async function loadCandidate(filename, map) {
  const safe = safeExportFilename(filename);
  const bytes = await readFile(path.join(EXPORT_DIR, safe));
  const workspace = new GeometryWorkspace(bytes, String(map).toUpperCase());
  return { safe, bytes, workspace };
}

function evaluationOptions(input) {
  return {
    profile: input.profile || 'balanced',
    skill: input.skill || 'medium',
    includeSecret: input.includeSecret !== false,
    allowDrops: input.allowDrops !== false
  };
}

function compactReport(report) {
  return {
    map: report.map,
    profile: report.profile,
    skill: report.skill,
    overallScore: report.overallScore,
    grade: report.grade,
    componentScores: report.componentScores,
    metrics: report.metrics,
    issues: report.issues
  };
}

export function createMcpServer() {
  const server = p2Module.createMcpServer();

  server.registerTool('doom_p2_game_design_status', {
    title: 'Read DOOM P2.1 game-design evaluator status',
    description: 'Read deterministic game-design scoring capabilities layered on top of P2.0 source-free map generation.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult({
    version: P2_GAME_DESIGN_SERVER_VERSION,
    evaluatorVersion: GAME_DESIGN_EVALUATOR_VERSION,
    policyVersion: GAME_DESIGN_POLICY_VERSION,
    exportDirectory: EXPORT_DIR,
    capabilities: [
      'deterministic_game_design_proxy_scoring',
      'reachability_and_progression_scoring',
      'topology_loop_branch_dead_end_metrics',
      'skill_filtered_combat_distribution',
      'normalized_resource_support_balance',
      'main_path_pacing_metrics',
      'before_after_design_comparison',
      'balanced_combat_exploration_profiles'
    ],
    boundary: 'P2.1 scores are deterministic proxies for iteration. Runtime QA and playtesting remain authoritative for actual play quality.'
  }));

  server.registerTool('doom_get_game_design_policy', {
    title: 'Read P2.1 game-design scoring policy',
    description: 'Return profile weights, target heuristic ranges and policy notes used by deterministic P2.1 evaluation.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => jsonResult(getGameDesignPolicy()));

  server.registerTool('doom_evaluate_game_design', {
    title: 'Evaluate a built DOOM candidate for game design',
    description: 'Evaluate a validated/exported PWAD using deterministic reachability, progression, topology, combat, resource and pacing proxies. Build the blank-map session first, then pass its export filename here.',
    inputSchema: z.object({
      filename: z.string().min(5).max(120),
      map: mapName,
      profile: profileName.optional(),
      skill: skillName.optional(),
      includeSecret: z.boolean().optional(),
      allowDrops: z.boolean().optional()
    }), annotations: { readOnlyHint: true, openWorldHint: false }
  }, async input => {
    try {
      const loaded = await loadCandidate(input.filename, input.map);
      const report = evaluateGameDesign(loaded.workspace, evaluationOptions(input));
      return jsonResult({ filename: loaded.safe, bytes: loaded.bytes.length, ...report });
    } catch (error) { return toolError(error); }
  });

  server.registerTool('doom_compare_game_design', {
    title: 'Compare two built DOOM candidates',
    description: 'Evaluate two exported PWAD candidates under the exact same P2.1 policy/profile and report score deltas plus resolved/new design issues.',
    inputSchema: z.object({
      beforeFilename: z.string().min(5).max(120),
      afterFilename: z.string().min(5).max(120),
      map: mapName,
      profile: profileName.optional(),
      skill: skillName.optional(),
      includeSecret: z.boolean().optional(),
      allowDrops: z.boolean().optional()
    }), annotations: { readOnlyHint: true, openWorldHint: false }
  }, async input => {
    try {
      const options = evaluationOptions(input);
      const beforeLoaded = await loadCandidate(input.beforeFilename, input.map);
      const afterLoaded = await loadCandidate(input.afterFilename, input.map);
      const before = evaluateGameDesign(beforeLoaded.workspace, options);
      const after = evaluateGameDesign(afterLoaded.workspace, options);
      return jsonResult({
        beforeFilename: beforeLoaded.safe,
        afterFilename: afterLoaded.safe,
        comparison: compareGameDesignReports(before, after),
        before: compactReport(before),
        after: compactReport(after)
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
  console.error(`DOOM MCP ${P2_GAME_DESIGN_SERVER_VERSION}: P2.1 deterministic game-design evaluation ready`);
}
