// In-game overlay for autoplay: draws the follower step and the latest Jev
// judgment on the runtime page's #hud layer (pointer-events: none), so a
// headed run (--headed) shows what the policy is doing next to the game and
// page screenshots carry the same panel.
//
// The overlay is DOM only. It never touches the engine, and the world is
// paused between steps, so it cannot change a trial's outcome or its tics.

const PANEL_ID = 'autoplayOverlay';

function pageInstall({ panelId, title }) {
  const host = document.getElementById('hud') || document.body;
  let panel = document.getElementById(panelId);
  if (panel) panel.remove();
  panel = document.createElement('div');
  panel.id = panelId;
  panel.innerHTML = `
    <style>
      #${panelId}{position:absolute;right:12px;top:12px;width:280px;pointer-events:none;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#eee;z-index:6}
      #${panelId} .box{background:rgba(0,0,0,.74);border:1px solid rgba(255,255,255,.18);border-radius:7px;padding:8px 10px;margin-bottom:6px;backdrop-filter:blur(6px)}
      #${panelId} .t{font-weight:900;letter-spacing:.08em;color:#fff;margin-bottom:4px}
      #${panelId} .row{display:flex;justify-content:space-between;gap:8px}
      #${panelId} .k{color:#9a9a9a}
      #${panelId} .bar{display:grid;grid-template-columns:62px 1fr 34px;align-items:center;gap:6px;margin:2px 0}
      #${panelId} .bar .track{height:7px;background:rgba(255,255,255,.12);border-radius:4px;overflow:hidden}
      #${panelId} .bar .fill{height:100%;background:#5aa0ff;border-radius:4px;transition:width .12s ease}
      #${panelId} .bar.pick .fill{background:#ffcf6b}
      #${panelId} .bar.pick .n{color:#ffcf6b;font-weight:900}
      #${panelId} .danger .fill{background:#e34948}
      #${panelId} .cmd{margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.14);color:#c8ffd3}
      #${panelId} .rule{display:inline-block;padding:1px 5px;border:1px solid rgba(255,207,107,.7);border-radius:4px;color:#ffcf6b;margin-left:4px}
      #${panelId} .idle{color:#777}
    </style>
    <div class="box">
      <div class="t">${title}</div>
      <div class="row"><span class="k">tic</span><span data-f="tic">–</span></div>
      <div class="row"><span class="k">health / armor</span><span data-f="health">–</span></div>
      <div class="row"><span class="k">sector / edge</span><span data-f="where">–</span></div>
      <div class="row"><span class="k">step source</span><span data-f="source">–</span></div>
    </div>
    <div class="box" data-f="jev">
      <div class="t">JEV</div>
      <div class="idle">no consultation yet</div>
    </div>`;
  host.appendChild(panel);
  return true;
}

function pageUpdate({ panelId, payload }) {
  const panel = document.getElementById(panelId);
  if (!panel) return false;
  const set = (name, text) => { const el = panel.querySelector(`[data-f="${name}"]`); if (el) el.textContent = text; };
  const pct = v => `${Math.round(Number(v || 0) * 100)}%`;
  if (payload.step) {
    const s = payload.step;
    set('tic', `${s.tic ?? '–'}  (${((Number(s.tic) || 0) / 35).toFixed(1)} s)`);
    set('health', `${s.health ?? '–'} / ${s.armor ?? '–'}`);
    set('where', `${s.sector ?? '–'} / ${s.edge ?? '–'}`);
    set('source', s.source || '–');
  }
  if (payload.jev) {
    const j = payload.jev;
    const box = panel.querySelector('[data-f="jev"]');
    if (!j.answers) {
      const stats = j.stats || {};
      box.innerHTML = `<div class="t">JEV <span class="k">@${j.tic} · ${j.kind === 'jev_dry_run' ? 'dry run, no API call' : j.kind || ''}</span></div>
        <div class="row"><span class="k">would send</span><span>${j.approxInputTokens ?? '–'} tokens · ${(j.state?.visibleEnemies || []).length} enemies</span></div>
        <div class="row"><span class="k">calls</span><span>${stats.calls ?? '–'}</span></div>`;
      return true;
    }
    const a = j.answers;
    const modeProbs = a.mode?.probabilities || {};
    const modes = ['advance', 'fight', 'retreat', 'dodge'];
    const finalMode = j.command?.mode || a.mode?.choice;
    const bars = modes.map(m => `<div class="bar${finalMode === m ? ' pick' : ''}"><span class="n">${m}</span><div class="track"><div class="fill" style="width:${pct(modeProbs[m])}"></div></div><span>${pct(modeProbs[m])}</span></div>`).join('');
    const targets = Object.entries(a.target?.probabilities || {}).sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([id, p]) => `${id === a.target?.choice ? '▶ ' : ''}${id} ${pct(p)}`).join('  ·  ');
    const fire = Number(a.fire?.noul ?? 0);
    const danger = Number(a.danger?.score ?? 0);
    const rules = (j.command?.rules || []).map(r => `<span class="rule">${r}</span>`).join('');
    const c = j.command;
    const cmd = c
      ? `→ ${c.mode}${c.attack ? ' + ATTACK' : ''}  fwd ${Number(c.forward ?? 0).toFixed(2)}  strafe ${Number(c.strafe ?? 0).toFixed(2)}  turn ${Number(c.turn ?? 0).toFixed(2)}`
      : '→ proposal kept (no override)';
    const stats = j.stats || {};
    box.innerHTML = `
      <div class="t">JEV <span class="k">@${j.tic} · ${j.latencyMs ?? '–'} ms · ${j.model || ''}</span></div>
      ${bars}
      <div class="bar"><span class="n">fire</span><div class="track"><div class="fill" style="width:${pct(fire)}"></div></div><span>${fire.toFixed(2)}</span></div>
      <div class="bar danger"><span class="n">danger</span><div class="track"><div class="fill" style="width:${pct(danger / 2)}"></div></div><span>${danger.toFixed(2)}</span></div>
      <div class="row"><span class="k">target</span><span>${targets || 'none'}</span></div>
      <div class="cmd">${cmd}${rules}${j.forced ? `<span class="rule">forced ${j.forced}</span>` : ''}</div>
      <div class="row"><span class="k">calls / overrides</span><span>${stats.calls ?? '–'} / ${stats.overrides ?? '–'}</span></div>
      <div class="row"><span class="k">est. cost</span><span>$${Number(stats.estimatedInputCostUsd ?? 0).toFixed(4)}</span></div>`;
  }
  return true;
}

export async function installOverlay(page, { title = 'AUTOPLAY' } = {}) {
  return page.evaluate(pageInstall, { panelId: PANEL_ID, title });
}

export async function updateOverlay(page, payload) {
  return page.evaluate(pageUpdate, { panelId: PANEL_ID, payload });
}
