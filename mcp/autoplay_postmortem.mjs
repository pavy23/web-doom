// Post-mortem of a policy trial: where each run took its damage and died.
//
//   node autoplay_postmortem.mjs exports/autoplay/e1m3-jev-hmp-x10 [--run N] [--top 6]
//
// For every run it lists the health drops (tic, amount, sector/edge, what the
// policy was doing and which enemies it saw at the nearest consultation), the
// death edge and the modes the run spent its tics in. steps.jsonl and
// jev.jsonl are the inputs; no engine is needed.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
if (!dir) { console.error('usage: node autoplay_postmortem.mjs <trial dir> [--run N] [--top N]'); process.exit(2); }
const onlyRun = args.includes('--run') ? Number(args[args.indexOf('--run') + 1]) : null;
const top = args.includes('--top') ? Number(args[args.indexOf('--top') + 1]) : 6;

async function readJsonl(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}
const steps = await readJsonl(path.join(dir, 'steps.jsonl'));
const jev = await readJsonl(path.join(dir, 'jev.jsonl'));
// report.json exists once the trial is over; before that, runs are derived
// from the step log so a trial can be read while it is still running.
let report;
try { report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')); }
catch {
  const indices = [...new Set(steps.map(s => s.run))];
  report = { runs: indices.map(runIndex => {
    const rows = steps.filter(s => s.run === runIndex);
    const last = rows[rows.length - 1];
    return { runIndex, passed: null, failure: last?.health <= 0 ? 'player_dead' : '(in progress or unknown)', failedEdge: last?.edge, totalTics: last?.worldTics };
  }) };
}

function nearestDecision(rows, tic) {
  let best = null;
  for (const row of rows) {
    if (!row.answers || row.tic > tic) continue;
    if (!best || row.tic > best.tic) best = row;
  }
  return best;
}
function enemyLine(decision) {
  const list = decision?.state?.visibleEnemies || [];
  return list.slice(0, 4).map(e => `${e.name}@${Math.round(e.distance)}${e.canHitPlayerNow ? '!' : ''}hp${e.health}`).join(' ');
}

for (const run of report.runs) {
  if (onlyRun != null && run.runIndex !== onlyRun) continue;
  const rows = steps.filter(s => s.run === run.runIndex);
  const decisions = jev.filter(j => j.run === run.runIndex);
  const drops = [];
  let health = rows[0]?.health ?? 100;
  for (const row of rows) {
    if (row.health < health) drops.push({ tic: row.worldTics, amount: health - row.health, health: row.health, edge: row.edge, sector: row.sector, mode: row.command?.mode || row.source, rules: row.command?.rules || [] });
    health = row.health;
  }
  const modeTics = {};
  for (const row of rows) { const key = row.command?.mode || row.source || '?'; modeTics[key] = (modeTics[key] || 0) + Number(row.command?.tics || 0); }
  const totalDamage = drops.reduce((sum, d) => sum + d.amount, 0);
  const status = run.passed === true ? 'CLEARED' : run.passed === false ? `FAILED ${run.failure || ''}` : String(run.failure || '');
  console.log(`run ${run.runIndex}: ${status} ${run.failedEdge || ''} tics ${run.totalTics} damage ${run.telemetry?.damageTaken ?? totalDamage} kills ${run.telemetry?.kills ?? '?'} minHealth ${run.telemetry?.minHealth ?? '?'}`);
  console.log(`  modes: ${Object.entries(modeTics).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const worst = drops.slice().sort((a, b) => b.amount - a.amount).slice(0, top).sort((a, b) => a.tic - b.tic);
  for (const drop of worst) {
    const decision = nearestDecision(decisions, drop.tic);
    const a = decision?.answers || {};
    console.log(`  tic ${drop.tic} -${drop.amount} -> ${drop.health} hp  ${drop.edge} s${drop.sector}  doing ${drop.mode}${drop.rules.length ? ' [' + drop.rules.join(',') + ']' : ''}  jev@${decision?.tic ?? '-'} ${decision ? `fight ${a.mode?.probabilities?.fight ?? '-'} retreat ${a.mode?.probabilities?.retreat ?? '-'} danger ${a.danger?.score ?? '-'}` : ''}  saw: ${enemyLine(decision)}`);
  }
  if (!run.passed) {
    const last = rows[rows.length - 1];
    const decision = nearestDecision(decisions, last?.worldTics ?? 0);
    console.log(`  end: tic ${last?.worldTics} at ${last?.edge} s${last?.sector} (${Math.round(last?.x)},${Math.round(last?.y)}) hp ${last?.health} doing ${last?.command?.mode || last?.source}  saw: ${enemyLine(decision)}`);
  }
}
