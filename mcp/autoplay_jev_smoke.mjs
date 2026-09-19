// One real Jev call over a recorded DOOM tactical state.
//
//   TYPESAFE_API_KEY=... node autoplay_jev_smoke.mjs [steps.jsonl]
//
// Confirms credentials, network reachability, the answer schema and the cost
// of a single decision before any autoplay trial spends money. With a
// steps.jsonl from a live run, the first step with visible enemies is used;
// otherwise a built-in E1M1 scene is sent.

import { readFile } from 'node:fs/promises';
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';

import { buildQuestions, compactState, answersToCommand, INPUT_TOKEN_PRICE_USD_PER_MILLION } from './autoplay_jev_policy.mjs';

const SAMPLE_STATE = {
  levelTime: 257,
  player: { health: 67, armor: 0, weapon: 1, ammo: { bullets: 44, shells: 0, cells: 0, rockets: 0 } },
  enemyCount: 11,
  visibleEnemyCount: 2,
  enemies: [
    { name: 'Imp', health: 60, distance: 210, relativeAngle: -12, lineOfSight: true, visible: true },
    { name: 'Zombieman', health: 20, distance: 380, relativeAngle: 35, lineOfSight: true, visible: true }
  ]
};

async function loadSceneFromLog(file) {
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const hit = lines.find(line => Number(line.visibleEnemies) > 0);
  if (!hit) return null;
  // The step log keeps a compact projection; rebuild the fields the policy reads.
  return {
    levelTime: hit.worldTics,
    player: { health: hit.health, armor: hit.armor, weapon: 1, ammo: { bullets: 50, shells: 0, cells: 0, rockets: 0 } },
    enemyCount: hit.visibleEnemies, visibleEnemyCount: hit.visibleEnemies,
    enemies: Array.from({ length: hit.visibleEnemies }, (_, i) => ({
      name: 'Zombieman', health: 20, distance: 300 + 90 * i, relativeAngle: 10 * (i + 1), lineOfSight: true, visible: true
    }))
  };
}

const logPath = process.argv[2];
const state = (logPath && await loadSceneFromLog(logPath)) || SAMPLE_STATE;
const compact = compactState(state, { targetDistance: 180, delta: 4 });
const questions = buildQuestions(compact, { choice, noul, score });
const proposal = { forward: 0.62, turn: 0, use: false, tics: 4 };

console.error('state:', JSON.stringify(compact));
const client = new TypeSafeClient();
const started = Date.now();
try {
  const result = await client.systemOne({ state: compact, questions });
  const latency = Date.now() - started;
  const command = answersToCommand(result.answers, compact, proposal);
  console.log(JSON.stringify({
    model: result.model,
    latencyMs: latency,
    usage: result.usage,
    estimatedCostUsd: Number(result.usage?.input_tokens || 0) / 1e6 * INPUT_TOKEN_PRICE_USD_PER_MILLION,
    answers: result.answers,
    command
  }, null, 2));
} catch (error) {
  const body = String(error?.body || error?.message || error);
  if (/allowlist|egress/i.test(body)) {
    console.error('Network policy blocks api.typesafe.ai. Add the host to the environment egress allowlist and retry.');
  } else if (Number(error?.status) === 401) {
    console.error('TYPESAFE_API_KEY was rejected (401). Check the key in console.typesafe.ai.');
  }
  console.error(error?.stack || error);
  process.exitCode = 1;
}
