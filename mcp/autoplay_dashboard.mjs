// Offline dashboard for an autoplay trial: one self-contained HTML page built
// from <reportDir>/report.json, steps.jsonl and jev.jsonl, optionally against
// a baseline trial directory. No API calls, no game runtime, no dependencies.
//
//   node autoplay_dashboard.mjs exports/autoplay/e1m1-jev [--baseline exports/autoplay/e1m1] [--out FILE]
//
// Shows the objective (deaths > damage > tics) as stat tiles with baseline
// deltas, health over world tics for both runs, the Jev decision stream (mode
// lanes, danger score) on the same time axis, mode counts and a full decision
// table (the accessible twin of the charts).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { OBJECTIVE_ORDER, compareToBaseline, rankRuns, runMetrics } from './autoplay_objective.mjs';

const MODES = ['advance', 'fight', 'retreat', 'dodge'];

async function readJsonl(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadTrial(dir) {
  const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
  const steps = await readJsonl(path.join(dir, 'steps.jsonl'));
  const decisions = (await readJsonl(path.join(dir, 'jev.jsonl'))).filter(row => row.kind === 'jev_decision' || row.kind === 'jev_dry_run');
  const bestIndex = rankRuns(report.runs)[0] ?? 0;
  return {
    dir,
    report,
    run: report.runs[bestIndex],
    metrics: runMetrics(report.runs[bestIndex]),
    steps: steps.filter(step => Number(step.run ?? 0) === bestIndex),
    decisions
  };
}

const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmt = (value, digits = 0) => value == null ? '–' : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const signed = (value, digits = 0) => value == null ? '' : `${value > 0 ? '+' : value < 0 ? '−' : '±'}${fmt(Math.abs(value), digits)}`;
const pct = value => value == null ? '–' : `${Math.round(Number(value) * 100)}%`;

// Delta tile: for every ranked metric lower is better.
function deltaTile(label, value, delta, unit = '', digits = 0, lowerIsBetter = true) {
  let cls = 'flat';
  let icon = '•';
  if (delta != null && delta !== 0) {
    const good = lowerIsBetter ? delta < 0 : delta > 0;
    cls = good ? 'good' : 'bad';
    icon = good ? '▼' : '▲';
    if (!lowerIsBetter) icon = good ? '▲' : '▼';
  }
  const deltaHtml = delta == null ? '<div class="delta flat">no baseline</div>'
    : `<div class="delta ${cls}"><span aria-hidden="true">${icon}</span> ${signed(delta, digits)}${unit} vs baseline</div>`;
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${fmt(value, digits)}<span class="unit">${unit}</span></div>${deltaHtml}</div>`;
}

function plainTile(label, value, note = '') {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note ? `<div class="delta flat">${esc(note)}</div>` : ''}</div>`;
}

// ---- SVG helpers -----------------------------------------------------------
const W = 960;
const PAD = { left: 62, right: 16, top: 14, bottom: 26 };
// Consultations further apart than this are not joined by a line: Jev was
// not asked in between, so there is no series there.
const MAX_GAP_TICS = 24;

function xScale(maxTic) {
  const inner = W - PAD.left - PAD.right;
  return tic => PAD.left + (Number(tic) / maxTic) * inner;
}

function ticksFor(maxTic) {
  const step = maxTic > 2000 ? 500 : maxTic > 800 ? 200 : 100;
  const out = [];
  for (let t = 0; t <= maxTic; t += step) out.push(t);
  return out;
}

function xAxis(maxTic, height, caption = false) {
  const x = xScale(maxTic);
  const y = height - PAD.bottom;
  return ticksFor(maxTic).map(t => `<g><line class="grid" x1="${x(t)}" y1="${PAD.top}" x2="${x(t)}" y2="${y}"/><text class="tick" x="${x(t)}" y="${y + 16}" text-anchor="middle">${t}</text></g>`).join('')
    + `<line class="axis" x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}"/>`
    + (caption ? `<text class="tick" x="${PAD.left}" y="${y + 16}" text-anchor="end" dx="-6">tics</text>` : '');
}

function linePath(points, x, y, maxGap = Infinity) {
  return points.map((p, i) => {
    const start = i === 0 || p[0] - points[i - 1][0] > maxGap;
    return `${start ? 'M' : 'L'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`;
  }).join('');
}

function healthChart(trial, baseline, maxTic) {
  const H = 220;
  const x = xScale(maxTic);
  const yMax = 100;
  const y = v => PAD.top + (1 - Math.max(0, Math.min(yMax, v)) / yMax) * (H - PAD.top - PAD.bottom);
  const series = trial.steps.map(s => [s.worldTics, s.health]);
  const base = baseline ? baseline.steps.map(s => [s.worldTics, s.health]) : null;
  const yTicks = [0, 25, 50, 75, 100].map(v => `<g><line class="grid" x1="${PAD.left}" y1="${y(v)}" x2="${W - PAD.right}" y2="${y(v)}"/><text class="tick" x="${PAD.left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text></g>`).join('');
  const last = series[series.length - 1];
  const baseLast = base ? base[base.length - 1] : null;
  // End labels sit above their dot unless the two dots are close, in which
  // case the lower one goes below. Anything within 12 hp of zero always goes above.
  const labelY = (point, other) => {
    const above = y(point[1]) - 8;
    const below = y(point[1]) + 14;
    if (!other) return above;
    const close = Math.abs(y(point[1]) - y(other[1])) < 20;
    if (!close) return above;
    return point[1] < other[1] && point[1] > 12 ? below : above;
  };
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" data-chart="health" role="img" aria-label="Player health over world tics">
    ${yTicks}${xAxis(maxTic, H)}
    ${base ? `<path class="line baseline" d="${linePath(base, x, y)}"/>` : ''}
    <path class="line series" d="${linePath(series, x, y)}"/>
    ${baseLast ? `<circle class="dot baseline" cx="${x(baseLast[0])}" cy="${y(baseLast[1])}" r="4"/><text class="endlabel" x="${x(baseLast[0]) - 8}" y="${labelY(baseLast, last)}" text-anchor="end">baseline ${baseLast[1]}</text>` : ''}
    <circle class="dot series" cx="${x(last[0])}" cy="${y(last[1])}" r="4"/>
    <text class="endlabel" x="${x(last[0]) - 8}" y="${labelY(last, baseLast)}" text-anchor="end">${esc(trial.report.policy)} ${last[1]}</text>
    <g class="cursor" hidden><line x1="0" y1="${PAD.top}" x2="0" y2="${H - PAD.bottom}"/></g>
  </svg>`;
}

function modeLanes(trial, maxTic) {
  const H = 150;
  const x = xScale(maxTic);
  const laneH = (H - PAD.top - PAD.bottom) / MODES.length;
  const laneY = mode => PAD.top + (MODES.indexOf(mode) + 0.5) * laneH;
  const lanes = MODES.map(mode => `<line class="grid" x1="${PAD.left}" y1="${laneY(mode)}" x2="${W - PAD.right}" y2="${laneY(mode)}"/><text class="tick" x="${PAD.left - 6}" y="${laneY(mode) + 4}" text-anchor="end">${mode}</text>`).join('');
  const dots = trial.decisions.map(d => {
    const mode = d.answers?.mode?.choice;
    if (!MODES.includes(mode)) return '';
    const cls = d.command ? 'dot series' : 'dot hollow';
    return `<circle class="${cls}" cx="${x(d.tic).toFixed(1)}" cy="${laneY(mode).toFixed(1)}" r="3.5"><title>tic ${d.tic}: ${mode} (${pct(d.answers.mode.probabilities?.[mode])}), ${d.command ? 'override' : 'proposal kept'}${d.forced ? `, forced ${d.forced} by stall rule` : ''}</title></circle>`;
  }).join('');
  // A stall-forced fight is drawn on the fight lane as a small square so the
  // reader can tell a rule from a model answer.
  const forced = trial.decisions.filter(d => d.forced && d.command?.mode).map(d =>
    `<rect class="forced" x="${(x(d.tic) - 3).toFixed(1)}" y="${(laneY(d.command.mode) - 3).toFixed(1)}" width="6" height="6"><title>tic ${d.tic}: ${d.command.mode} forced by stall rule (model said ${d.answers?.mode?.choice})</title></rect>`
  ).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" data-chart="modes" role="img" aria-label="Jev mode choice per consultation">
    ${lanes}${xAxis(maxTic, H)}${dots}${forced}
    <g class="cursor" hidden><line x1="0" y1="${PAD.top}" x2="0" y2="${H - PAD.bottom}"/></g>
  </svg>`;
}

function dangerChart(trial, maxTic) {
  const H = 150;
  const x = xScale(maxTic);
  const y = v => PAD.top + (1 - Math.max(0, Math.min(2, v)) / 2) * (H - PAD.top - PAD.bottom);
  const pts = trial.decisions.filter(d => d.answers?.danger?.score != null).map(d => [d.tic, Number(d.answers.danger.score)]);
  const yTicks = [[0, 'safe'], [1, 'caution'], [2, 'critical']].map(([v, name]) => `<g><line class="grid" x1="${PAD.left}" y1="${y(v)}" x2="${W - PAD.right}" y2="${y(v)}"/><text class="tick" x="${PAD.left - 6}" y="${y(v) + 4}" text-anchor="end">${name}</text></g>`).join('');
  const dots = pts.map(p => `<circle class="dot series small" cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="3"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" data-chart="danger" role="img" aria-label="Jev danger score per consultation">
    ${yTicks}${xAxis(maxTic, H, true)}
    ${pts.length ? `<path class="line series thin" d="${linePath(pts, x, y, MAX_GAP_TICS)}"/>` : ''}${dots}
    <g class="cursor" hidden><line x1="0" y1="${PAD.top}" x2="0" y2="${H - PAD.bottom}"/></g>
  </svg>`;
}

function modeBars(trial) {
  const counts = Object.fromEntries(MODES.map(m => [m, 0]));
  for (const d of trial.decisions) if (MODES.includes(d.answers?.mode?.choice)) counts[d.answers.mode.choice]++;
  const max = Math.max(1, ...Object.values(counts));
  const rowH = 30;
  const H = MODES.length * rowH + 8;
  const left = 70;
  const inner = 420 - left - 60;
  const bars = MODES.map((m, i) => {
    const w = (counts[m] / max) * inner;
    const y = 4 + i * rowH;
    return `<text class="tick" x="${left - 8}" y="${y + 16}" text-anchor="end">${m}</text>
      <rect class="bar" x="${left}" y="${y + 3}" width="${Math.max(w, 0).toFixed(1)}" height="18" rx="0"><title>${m}: ${counts[m]}</title></rect>
      <text class="value" x="${left + w + 8}" y="${y + 16}">${counts[m]}</text>`;
  }).join('');
  return `<svg class="chart bars" viewBox="0 0 420 ${H}" role="img" aria-label="Mode choices per trial">${bars}</svg>`;
}

function decisionTable(trial) {
  if (!trial.decisions.length) return '<p class="muted">No Jev decisions recorded for this trial.</p>';
  const rows = trial.decisions.map(d => {
    const a = d.answers || {};
    const mode = a.mode?.choice;
    const target = a.target?.choice;
    const targetName = d.state?.visibleEnemies?.find(e => e.id === target)?.name || target || '–';
    const cmd = d.command;
    const cmdText = cmd ? `${cmd.mode} · fwd ${fmt(cmd.forward, 2)} · strafe ${fmt(cmd.strafe ?? 0, 2)} · turn ${fmt(cmd.turn ?? 0, 2)}${cmd.attack ? ' · ATTACK' : ''}${cmd.rules?.length ? ` · rule: ${cmd.rules.join('+')}` : ''}` : 'kept proposal';
    return `<tr><td>${d.tic}</td><td>${d.state?.player?.health ?? '–'}</td><td>${d.state?.visibleEnemies?.length ?? 0}</td>
      <td>${esc(mode || (d.kind === 'jev_dry_run' ? 'dry run' : '–'))} <span class="muted">${pct(a.mode?.probabilities?.[mode])}</span></td>
      <td>${esc(targetName)} <span class="muted">${pct(a.target?.probabilities?.[target])}</span></td>
      <td>${a.fire?.noul == null ? '–' : fmt(a.fire.noul, 2)}</td>
      <td>${a.danger?.score == null ? '–' : fmt(a.danger.score, 2)}</td>
      <td>${esc(cmdText)}</td><td>${d.latencyMs ?? '–'}</td><td>${d.usage?.input_tokens ?? d.approxInputTokens ?? '–'}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>tic</th><th>health</th><th>enemies</th><th>mode</th><th>target</th><th>fire</th><th>danger</th><th>command</th><th>ms</th><th>tokens</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderDashboard(trial, baseline) {
  const m = trial.metrics;
  const comparison = baseline ? compareToBaseline(trial.report.runs, baseline.report) : null;
  const delta = comparison?.delta || {};
  const policy = trial.run?.policy || {};
  const maxTic = Math.max(
    ...trial.steps.map(s => Number(s.worldTics) || 0),
    ...(baseline ? baseline.steps.map(s => Number(s.worldTics) || 0) : [0]),
    1
  );
  const consultedTics = trial.decisions.map(d => d.tic);
  const firstTic = consultedTics.length ? Math.min(...consultedTics) : null;
  const lastTic = consultedTics.length ? Math.max(...consultedTics) : null;
  const modeOf = Object.fromEntries(trial.decisions.map(d => [d.tic, { mode: d.answers?.mode?.choice || null, danger: d.answers?.danger?.score ?? null, override: Boolean(d.command) }]));
  const hoverData = {
    maxTic,
    series: trial.steps.map(s => [s.worldTics, s.health]),
    baseline: baseline ? baseline.steps.map(s => [s.worldTics, s.health]) : null,
    decisions: modeOf,
    pad: PAD, width: W
  };
  const verdictLine = comparison ? comparison.verdict : 'no baseline given';
  const title = `${trial.report.map} autoplay · ${trial.report.policy}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --series: #2a78d6; --baseline: #898781;
  --good: #006300; --bad: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --series: #3987e5; --baseline: #898781; --good: #0ca30c; --bad: #d03b3b;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --series: #3987e5; --baseline: #898781; --good: #0ca30c; --bad: #d03b3b;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 8px; color: var(--ink-2); font-weight: 600; }
.sub { color: var(--ink-2); margin: 0 0 18px; }
.verdict { display: inline-block; padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); font-weight: 600; }
.verdict.good { color: var(--good); } .verdict.bad { color: var(--bad); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.tile .label { color: var(--ink-2); font-size: 12px; }
.tile .value { font-size: 28px; font-weight: 600; margin: 2px 0; }
.tile .unit { font-size: 14px; color: var(--muted); margin-left: 3px; font-weight: 500; }
.delta { font-size: 12px; color: var(--muted); }
.delta.good { color: var(--good); } .delta.bad { color: var(--bad); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px 8px; position: relative; }
.card + .card { margin-top: 10px; }
.card h3 { font-size: 13px; font-weight: 600; margin: 0 0 6px; color: var(--ink-2); }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-bottom: 4px; flex-wrap: wrap; }
.legend span::before { content: ""; display: inline-block; width: 14px; height: 3px; border-radius: 2px; margin-right: 6px; vertical-align: middle; background: var(--series); }
.legend .base::before { background: var(--baseline); }
.legend .hollow::before { width: 8px; height: 8px; border: 2px solid var(--series); background: var(--surface); border-radius: 50%; }
.legend .filled::before { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--series); }
.legend .square::before { width: 8px; height: 8px; border-radius: 1px; background: var(--ink-2); }
.forced { fill: var(--ink-2); }
svg.chart { width: 100%; height: auto; display: block; min-width: 640px; }
svg.bars { max-width: 420px; min-width: 0; }
.chartwrap { overflow-x: auto; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.value { fill: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.endlabel { fill: var(--ink-2); font-size: 11px; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.line.series { stroke: var(--series); }
.line.thin { stroke-width: 1.5; }
.line.baseline { stroke: var(--baseline); }
.dot { stroke: var(--surface); stroke-width: 2; }
.dot.series { fill: var(--series); }
.dot.baseline { fill: var(--baseline); }
.dot.hollow { fill: var(--surface); stroke: var(--series); stroke-width: 2; }
.bar { fill: var(--series); }
.cursor line { stroke: var(--ink-2); stroke-width: 1; }
.tooltip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12px; color: var(--ink); box-shadow: 0 4px 16px rgba(0,0,0,0.12); white-space: nowrap; z-index: 2; }
.tooltip[hidden] { display: none; }
table { border-collapse: collapse; width: 100%; font-size: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); font-variant-numeric: tabular-nums; vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; position: sticky; top: 0; background: var(--surface); }
.tablewrap { max-height: 420px; overflow: auto; border-radius: 10px; }
.muted { color: var(--muted); }
details summary { cursor: pointer; color: var(--ink-2); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 720px) { .two { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="sub">Objective: ${OBJECTIVE_ORDER.join(' › ')} (lower is better). ${baseline ? `Baseline: ${esc(baseline.report.policy)} policy, ${esc(path.basename(baseline.dir))}.` : ''}
  <span class="verdict ${comparison ? (comparison.better ? 'good' : comparison.verdict.startsWith('equal') ? '' : 'bad') : ''}">${esc(verdictLine)}</span></p>

<div class="tiles">
  ${deltaTile('Deaths', m.deaths, delta.deaths)}
  ${deltaTile('Damage taken', m.damageTaken, delta.damageTaken, ' hp')}
  ${m.cleared
    ? deltaTile('Clear time', m.seconds, delta.totalTics == null ? null : delta.totalTics / 35, ' s', 1)
    : plainTile('Time alive', `${fmt(m.seconds, 1)} s`, `did not clear (${esc(trial.run?.failure || 'failed')})`)}
  ${plainTile('Kills', fmt(m.kills), delta.kills == null ? 'not ranked' : `${signed(delta.kills)} vs baseline · not ranked`)}
  ${plainTile('Jev calls', trial.decisions.length ? `${policy.calls ?? trial.decisions.length}` : '0', policy.overrides != null ? `${policy.overrides} overrides${policy.rules ? ` · rules: stall ${policy.rules.stall ?? 0}, point-blank ${policy.rules.pointBlank ?? 0}` : ''}${policy.capped ? ' · capped' : ''}` : '')}
  ${plainTile('Estimated cost', policy.estimatedInputCostUsd != null ? `$${fmt(policy.estimatedInputCostUsd, 4)}` : '–', policy.inputTokens != null ? `${fmt(policy.inputTokens)} input tokens · ${policy.avgLatencyMs != null ? `${policy.avgLatencyMs} ms avg` : 'dry run'}` : '')}
</div>

<h2>Timeline</h2>
<div class="card" id="charts">
  <h3>Player health</h3>
  <div class="legend"><span>${esc(trial.report.policy)} run</span>${baseline ? `<span class="base">baseline (${esc(baseline.report.policy)})</span>` : ''}</div>
  <div class="chartwrap">${healthChart(trial, baseline, maxTic)}</div>
  <h3 style="margin-top:14px">Jev mode per consultation${firstTic != null ? ` <span class="muted">(tics ${firstTic}–${lastTic})</span>` : ''}</h3>
  <div class="legend"><span class="filled">override applied</span><span class="hollow">proposal kept</span><span class="square">forced by stall rule</span></div>
  <div class="chartwrap">${modeLanes(trial, maxTic)}</div>
  <h3 style="margin-top:14px">Danger score (Jev) <span class="muted">· world tics, 35 = 1 s</span></h3>
  <div class="chartwrap">${dangerChart(trial, maxTic)}</div>
  <div class="tooltip" id="tooltip" hidden></div>
</div>

<div class="two" style="margin-top:10px">
  <div class="card"><h3>Mode choices</h3>${modeBars(trial)}</div>
  <div class="card"><h3>Route</h3>
    <p class="muted" style="margin:0">${trial.report.plan?.sectors?.length ?? '–'} route sectors · ${trial.report.plan?.transitions?.length ?? '–'} transitions · exit line ${trial.report.plan?.exit?.line ?? trial.report.plan?.exit?.linedef ?? '–'}<br>
    ${trial.steps.length} steps · ${fmt(m.totalTics)} world tics · min health ${m.minHealth ?? '–'} · ammo left ${m.ammoLeft ? Object.entries(m.ammoLeft).map(([k, v]) => `${k} ${v}`).join(', ') : '–'}</p>
  </div>
</div>

<h2>Decisions</h2>
<div class="tablewrap">${decisionTable(trial)}</div>

<details style="margin-top:18px"><summary>Trial metadata</summary>
<pre class="muted" style="font-size:12px;white-space:pre-wrap">${esc(JSON.stringify({ report: trial.report.reportPath, version: trial.report.version, policyVersion: policy.version, startedAt: trial.report.startedAt, completedAt: trial.report.completedAt, baseline: baseline?.report?.reportPath || null }, null, 2))}</pre>
</details>
</main>
<script>
(function () {
  const data = ${JSON.stringify(hoverData)};
  const card = document.getElementById('charts');
  const tip = document.getElementById('tooltip');
  const charts = Array.from(card.querySelectorAll('svg.chart'));
  const cursors = charts.map(svg => svg.querySelector('.cursor'));
  const inner = data.width - data.pad.left - data.pad.right;
  const nearest = (arr, tic) => {
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < tic) lo = mid + 1; else hi = mid; }
    return arr[lo];
  };
  const nearestDecision = tic => {
    let best = null, bestD = Infinity;
    for (const key of Object.keys(data.decisions)) { const d = Math.abs(Number(key) - tic); if (d < bestD) { bestD = d; best = key; } }
    return bestD <= 12 ? { tic: Number(best), ...data.decisions[best] } : null;
  };
  function show(evt, svg) {
    const rect = svg.getBoundingClientRect();
    const px = (evt.clientX - rect.left) / rect.width * data.width;
    if (px < data.pad.left || px > data.width - data.pad.right) return hide();
    const tic = Math.round((px - data.pad.left) / inner * data.maxTic);
    cursors.forEach(c => { c.hidden = false; c.querySelector('line').setAttribute('x1', px); c.querySelector('line').setAttribute('x2', px); });
    const s = nearest(data.series, tic), b = nearest(data.baseline, tic), d = nearestDecision(tic);
    const rows = ['<b>tic ' + tic + '</b> · ' + (tic / 35).toFixed(1) + ' s'];
    if (s) rows.push('health: ' + s[1]);
    if (b) rows.push('baseline health: ' + b[1]);
    if (d) rows.push('jev @' + d.tic + ': ' + (d.mode || 'dry run') + (d.danger != null ? ' · danger ' + Number(d.danger).toFixed(2) : '') + (d.override ? ' · override' : ' · kept'));
    tip.innerHTML = rows.join('<br>');
    tip.hidden = false;
    const cr = card.getBoundingClientRect();
    const left = evt.clientX - cr.left + 14, top = evt.clientY - cr.top - 10;
    tip.style.left = Math.min(left, cr.width - tip.offsetWidth - 8) + 'px';
    tip.style.top = top + 'px';
  }
  function hide() { tip.hidden = true; cursors.forEach(c => { c.hidden = true; }); }
  charts.forEach(svg => { svg.addEventListener('mousemove', e => show(e, svg)); svg.addEventListener('mouseleave', hide); });
})();
</script>
</body>
</html>
`;
}

export async function buildDashboard({ reportDir, baselineDir, out }) {
  const trial = await loadTrial(reportDir);
  const baseline = baselineDir ? await loadTrial(baselineDir) : null;
  const html = renderDashboard(trial, baseline);
  const file = out || path.join(reportDir, 'dashboard.html');
  await writeFile(file, html);
  return { file, decisions: trial.decisions.length, steps: trial.steps.length, baseline: Boolean(baseline) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { values, positionals } = parseArgs({
    options: { baseline: { type: 'string' }, out: { type: 'string' } },
    allowPositionals: true
  });
  const reportDir = path.resolve(positionals[0] || 'exports/autoplay/e1m1-jev');
  try {
    const result = await buildDashboard({
      reportDir,
      baselineDir: values.baseline ? path.resolve(values.baseline) : null,
      out: values.out ? path.resolve(values.out) : null
    });
    console.error(`autoplay dashboard: ${result.file} (${result.steps} steps, ${result.decisions} decisions${result.baseline ? ', with baseline' : ''})`);
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
