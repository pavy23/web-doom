// Compare autoplay trials: clear rate with a 95% Wilson interval, damage and
// tic distributions over all runs, and the health lost on named edges.
//
//   node autoplay_compare.mjs exports/autoplay/e1m1-uv exports/autoplay/e1m1-rules-uv exports/autoplay/e1m1-jev-uv \
//        [--edges 7:54:385,60:56:194] [--json]
//
// Reads report.json in each directory. Meant for trials with 10+ runs; with
// three runs the intervals say why a 3/3 and a 0/3 can be the same policy.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runMetrics } from './autoplay_objective.mjs';

export function wilson(successes, n, z = 1.96) {
  if (!n) return { low: 0, high: 1, rate: null };
  const p = successes / n;
  const denominator = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function quantiles(values) {
  const sorted = values.filter(v => v != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))];
  return { n: sorted.length, min: sorted[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: sorted[sorted.length - 1] };
}

// Health lost while traversing one edge: entry health (previous edge's end,
// or 100) minus this edge's end health. Runs that never reached the edge
// are excluded; runs that died on it count the loss to 0.
function edgeLoss(run, edgeId) {
  const edges = run.edgeResults || [];
  const index = edges.findIndex(e => e.edge === edgeId);
  if (index < 0) return null;
  const entry = index === 0 ? 100 : Number(edges[index - 1].health ?? 100);
  return entry - Number(edges[index].health ?? 0);
}

export async function summariseTrial(dir, edgeIds) {
  const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
  const runs = report.runs || [];
  const metrics = runs.map(runMetrics);
  const cleared = metrics.filter(m => m.cleared).length;
  const interval = wilson(cleared, runs.length);
  const cost = runs.reduce((sum, run) => sum + Number(run.policy?.estimatedInputCostUsd || 0), 0);
  return {
    dir: path.basename(dir),
    policy: report.policy,
    skill: runs[0]?.skill ?? null,
    runs: runs.length,
    cleared,
    clearRate: interval,
    damage: quantiles(metrics.map(m => m.damageTaken)),
    damageCleared: quantiles(metrics.filter(m => m.cleared).map(m => m.damageTaken)),
    ticsCleared: quantiles(metrics.filter(m => m.cleared).map(m => m.totalTics)),
    kills: quantiles(metrics.map(m => m.kills)),
    edges: Object.fromEntries(edgeIds.map(id => [id, { loss: quantiles(runs.map(run => edgeLoss(run, id))), reached: runs.filter(run => edgeLoss(run, id) != null).length }])),
    deathEdges: runs.filter(run => !run.passed).reduce((acc, run) => { const k = `${run.failedEdge || '?'}:${run.failure || '?'}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    costUsd: Math.round(cost * 1000) / 1000
  };
}

const pct = v => v == null ? '–' : `${Math.round(v * 100)}%`;
const q = s => s ? `${s.median} [${s.min}–${s.max}]` : '–';

export function renderTable(rows, edgeIds) {
  const head = ['trial', 'policy', 'skill', 'runs', 'cleared', '95% CI', 'damage med [min–max]', 'dmg (cleared)', 'tics (cleared)', 'kills', ...edgeIds.map(id => `hp lost @${id}`), 'deaths at', 'cost'];
  const lines = rows.map(r => [
    r.dir, r.policy, r.skill ?? '–', r.runs, `${r.cleared}/${r.runs} (${pct(r.clearRate.rate)})`, `${pct(r.clearRate.low)}–${pct(r.clearRate.high)}`,
    q(r.damage), q(r.damageCleared), q(r.ticsCleared), q(r.kills),
    ...edgeIds.map(id => `${q(r.edges[id].loss)} (${r.edges[id].reached} reached)`),
    Object.entries(r.deathEdges).map(([k, v]) => `${k}×${v}`).join(' ') || '–',
    `$${r.costUsd}`
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map(l => String(l[i]).length)));
  const fmt = row => row.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [fmt(head), fmt(widths.map(w => '-'.repeat(w))), ...lines.map(fmt)].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { values, positionals } = parseArgs({ options: { edges: { type: 'string', default: '7:54:385,60:56:194' }, json: { type: 'boolean', default: false } }, allowPositionals: true });
  const edgeIds = values.edges.split(',').map(s => s.trim()).filter(Boolean);
  const rows = [];
  for (const dir of positionals) {
    try { rows.push(await summariseTrial(path.resolve(dir), edgeIds)); } catch (error) { console.error(`${dir}: ${error.message}`); }
  }
  if (values.json) console.log(JSON.stringify(rows, null, 2));
  else console.log(renderTable(rows, edgeIds));
}
