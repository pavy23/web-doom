import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { GeometryWorkspace } from './geometry.js';
import { evaluateDeathmatchFairness } from './deathmatch_design.js';

const core = await import('./p2_deathmatch_bot_server.js');
const { startBridge: startAuthoringBridge } = await import('./server.js');
const { startPlaytestBridge } = await import('./playtest_server.js');
const { startOrchestrationBridge } = await import('./v1_server.js');
const { startCheatBridge } = await import('./cheat_server.js');
const geometryModule = await import('./geometry_server.js');

export const P2_HUMAN_BOT_SERVER_VERSION = '2.8.0-p2.2';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(process.env.DOOM_MCP_EXPORT_DIR || path.join(MODULE_DIR, 'exports'));
const skillName = z.enum(['easy', 'normal', 'hard', 'nightmare']);
const mapName = z.string().regex(/^(?:E[1-9]M[1-9]|MAP\d\d)$/i);

function jsonResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
function toolError(error) { return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] }; }
function safeFilename(value) {
  const raw = String(value || '').trim();
  if (!raw || raw !== path.basename(raw) || !/^[A-Za-z0-9._-]+\.wad$/i.test(raw)) throw new Error('filename must be a safe exported .wad filename');
  return raw;
}

export function humanBotLaunchUrl({ filename, map = 'E1M1', botSkills = ['normal', 'normal', 'normal'], port = Number(process.env.DOOM_MCP_PORT || 3777) }) {
  const safe = safeFilename(filename);
  const upperMap = String(map).toUpperCase();
  const skills = [...botSkills];
  if (!skills.length) skills.push('normal');
  while (skills.length < 3) skills.push(skills[skills.length - 1]);
  if (skills.length > 3) skills.length = 3;
  const params = new URLSearchParams({
    wad: safe,
    p22Bots: skills.join(','),
    p22Map: upperMap
  });
  return `http://127.0.0.1:${Number(port)}/?${params.toString()}`;
}

export function createMcpServer() {
  const server = core.createMcpServer();

  server.registerTool('doom_prepare_human_bot_arena', {
    title: 'Prepare an interactive human + three bots arena',
    description: 'Validate an exported P2.2 deathmatch PWAD and return a localhost browser URL where Player 1 stays on keyboard/mouse while Players 2–4 are controlled by configurable local AI bots.',
    inputSchema: z.object({
      filename: z.string().min(5).max(120),
      map: mapName,
      botSkills: z.array(skillName).min(1).max(3).optional()
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async input => {
    try {
      const filename = safeFilename(input.filename);
      const wadPath = path.join(EXPORT_DIR, filename);
      await access(wadPath);
      const bytes = await readFile(wadPath);
      const workspace = new GeometryWorkspace(bytes, String(input.map).toUpperCase());
      const fairness = evaluateDeathmatchFairness(workspace);
      if (fairness.metrics.deathmatchStarts < 4) throw new Error(`Candidate has only ${fairness.metrics.deathmatchStarts} valid deathmatch starts`);
      const botSkills = input.botSkills || ['normal', 'normal', 'normal'];
      const launchUrl = humanBotLaunchUrl({ filename, map: input.map, botSkills });
      return jsonResult({
        version: P2_HUMAN_BOT_SERVER_VERSION,
        filename,
        map: String(input.map).toUpperCase(),
        launchUrl,
        controls: {
          player1: 'human keyboard/mouse',
          player2: `bot:${botSkills[0] || 'normal'}`,
          player3: `bot:${botSkills[1] || botSkills[0] || 'normal'}`,
          player4: `bot:${botSkills[2] || botSkills[botSkills.length - 1] || 'normal'}`
        },
        fairness: {
          overallScore: fairness.overallScore,
          grade: fairness.grade,
          issues: fairness.issues.map(row => row.code)
        },
        instructions: [
          'Open launchUrl while this MCP server is running.',
          'Click CLICK TO START; Player 1 remains normal keyboard/mouse control.',
          'Bots run in the same LinuxDOOM process and use real player slots 2–4.',
          "In the browser console, DoomLocalBots.status() shows bot/player state and DoomLocalBots.setSkill(1, 'hard') changes Player 2 difficulty live."
        ],
        runtimeRequirement: 'The local game bridge must serve the P2.2 bot-capable LinuxDOOM build. The P2.2 CI gate builds and validates this runtime; remote networking is not involved.'
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
  console.error(`DOOM MCP ${P2_HUMAN_BOT_SERVER_VERSION}: interactive human+3-bots launcher ready`);
}
