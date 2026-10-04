// AI OS Dashboard UI. Vanilla ES module, no build step, no third-party code.
// All user/model text is rendered with textContent; nothing is parsed as HTML.

const $ = (sel, root = document) => root.querySelector(sel);
const SVG = 'http://www.w3.org/2000/svg';
const TOKEN_KEY = 'aios.token';

const fmt = {
  int: (n) => Math.round(n).toLocaleString(),
  usd: (n) => (n >= 1 ? `$${n.toFixed(2)}` : n === 0 ? '$0' : `$${Number(n.toPrecision(3))}`),
  pct: (n) => `${(n * 100).toFixed(1)}%`,
  ms: (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`),
  compact: (n) => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n),
  when: (ts) => new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }),
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function readToken() {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    const entered = window.prompt('This dashboard requires an access token (AIOS_TOKEN):');
    if (entered) {
      try { sessionStorage.setItem(TOKEN_KEY, entered.trim()); } catch { /* storage unavailable */ }
      return api(path, { method, body });
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, kind = 'error') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind === 'info' ? 'info' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ---- charts ------------------------------------------------------------------------------------

const tooltip = $('#tooltip');
function showTip(evt, text) {
  tooltip.textContent = text;
  tooltip.hidden = false;
  const pad = 12;
  const { innerWidth: w } = window;
  const box = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.min(evt.clientX + pad, w - box.width - pad)}px`;
  tooltip.style.top = `${evt.clientY - box.height - pad}px`;
}
const hideTip = () => { tooltip.hidden = true; };

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * exp).find((m) => m >= v);
}

/** Single-series bar chart. 4px rounded top, 2px gap, baseline-anchored, hover tooltip per bar. */
function barChart(container, points, { value, format, label }) {
  const W = Math.max(240, Math.round(container.clientWidth || 600)), H = 200, L = 44, R = 8, T = 10, B = 24;
  const max = niceMax(Math.max(...points.map(value), 0));
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label}: ${points.map((p) => `${p.date} ${format(value(p))}`).join(', ')}`);
  const mk = (tag, attrs) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const y = (v) => T + (H - T - B) * (1 - v / max);
  for (const f of [0.5, 1]) {
    svg.append(mk('line', { class: 'gridline', x1: L, x2: W - R, y1: y(max * f), y2: y(max * f) }));
    const t = mk('text', { x: L - 6, y: y(max * f) + 4, 'text-anchor': 'end' });
    t.textContent = format(max * f);
    svg.append(t);
  }
  const slot = (W - L - R) / Math.max(points.length, 1);
  const bw = Math.max(2, Math.min(28, slot - 2));
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor((W - L - R) / 52))));
  points.forEach((p, i) => {
    const v = value(p);
    const x = L + i * slot + (slot - bw) / 2;
    const top = y(v);
    const h = H - B - top;
    const g = mk('g', {});
    if (h > 0) {
      const r = Math.min(4, bw / 2, h);
      g.append(mk('path', {
        class: 'bar',
        d: `M${x},${H - B} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - B} Z`,
      }));
    }
    const hit = mk('rect', { class: 'hit', x: L + i * slot, y: T, width: slot, height: H - T - B });
    const tip = `${p.date}  ·  ${format(v)}`;
    hit.addEventListener('mousemove', (e) => showTip(e, tip));
    hit.addEventListener('mouseleave', hideTip);
    g.append(hit);
    svg.append(g);
    if ((points.length - 1 - i) % labelEvery === 0) { // evenly spaced, always including the latest day
      const t = mk('text', { x: L + i * slot + slot / 2, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = p.date.slice(5);
      svg.append(t);
    }
  });
  svg.append(mk('line', { class: 'baseline', x1: L, x2: W - R, y1: H - B, y2: H - B }));
  container.replaceChildren(svg);
}

// ---- views -------------------------------------------------------------------------------------

const state = { models: [], agents: [], selectedAgent: null, daily: null };

function kpi(label, value, sub) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
    el('div', { class: 'sub', text: sub ?? '' }));
}

let overviewSeq = 0;
function drawCharts() {
  if (!state.daily) return;
  barChart($('#chart-runs .plot'), state.daily, { value: (p) => p.runs, format: fmt.int, label: 'Runs per day' });
  barChart($('#chart-cost .plot'), state.daily, { value: (p) => p.cost_usd, format: fmt.usd, label: 'Cost per day' });
}

async function renderOverview() {
  const seq = ++overviewSeq;
  const days = Number($('#window').value);
  const o = await api(`/api/overview?days=${days}`);
  if (seq !== overviewSeq) return; // a newer render started while this one was in flight
  const t = o.totals;
  $('#kpis').replaceChildren(
    kpi('Runs', fmt.int(t.runs), `${fmt.int(t.errors)} errors · ${fmt.int(t.refusals)} refusals`),
    kpi('Error rate', fmt.pct(t.error_rate), 'provider errors / runs'),
    kpi('Estimated cost', fmt.usd(t.cost_usd), `${days === 1 ? 'today' : `last ${days} days`}`),
    kpi('Cache hit rate', fmt.pct(t.cache_hit_rate), `${fmt.compact(t.cache_read_tokens)} cached prompt tokens`),
    kpi('Tokens', fmt.compact(t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens),
      `${fmt.compact(t.output_tokens)} output`),
    kpi('Latency p50 / p95', `${fmt.ms(t.latency_p50_ms)}`, `p95 ${fmt.ms(t.latency_p95_ms)}`),
  );
  state.daily = o.daily;
  drawCharts();

  const body = $('#agent-table tbody');
  body.replaceChildren(...(o.agents.length ? o.agents.map((a) => el('tr', {},
    el('td', { text: a.agent_name }),
    el('td', { class: 'num', text: fmt.int(a.runs) }),
    el('td', { class: 'num', text: fmt.int(a.errors) }),
    el('td', { class: 'num', text: fmt.compact(a.tokens) }),
    el('td', { class: 'num', text: fmt.usd(a.cost_usd) }),
    el('td', { class: 'num', text: fmt.ms(a.avg_latency_ms) }),
  )) : [el('tr', {}, el('td', { class: 'empty', colspan: '6', text: 'No runs in this window yet.' }))]));
}

async function loadAgents() {
  state.agents = await api('/api/agents');
  const list = $('#agent-list');
  list.replaceChildren(...state.agents.map((a) => {
    const b = el('button', { type: 'button', 'aria-current': String(a.id === state.selectedAgent) },
      el('span', { text: a.name + (a.enabled ? '' : ' (disabled)') }), el('small', { text: a.model.replace('claude-', '') }));
    b.addEventListener('click', () => editAgent(a));
    return el('li', {}, b);
  }));
  if (!state.agents.length) list.replaceChildren(el('li', { class: 'empty', text: 'No agents yet.' }));
  const sel = $('#run-agent');
  const prev = sel.value;
  sel.replaceChildren(...state.agents.filter((a) => a.enabled).map((a) => el('option', { value: String(a.id), text: `${a.name} · ${a.model}` })));
  if (prev) sel.value = prev;
}

function editAgent(agent) {
  const f = $('#agent-form');
  state.selectedAgent = agent?.id ?? null;
  f.reset();
  f.elements.id.value = agent?.id ?? '';
  f.elements.name.value = agent?.name ?? '';
  f.elements.model.value = agent?.model ?? 'claude-opus-5-5';
  f.elements.effort.value = agent?.effort ?? 'medium';
  f.elements.system_prompt.value = agent?.system_prompt ?? '';
  f.elements.enabled.checked = agent?.enabled ?? true;
  $('#agent-form-title').textContent = agent ? `Edit ${agent.name}` : 'New agent';
  $('#delete-agent').hidden = !agent;
  loadAgents().catch((e) => toast(e.message));
}

async function saveAgent(evt) {
  evt.preventDefault();
  const f = evt.target;
  const body = {
    name: f.elements.name.value,
    model: f.elements.model.value,
    effort: f.elements.effort.value,
    system_prompt: f.elements.system_prompt.value,
    enabled: f.elements.enabled.checked,
  };
  const id = f.elements.id.value;
  const saved = await api(id ? `/api/agents/${id}` : '/api/agents', { method: id ? 'PATCH' : 'POST', body });
  toast(`Saved ${saved.name}`, 'info');
  editAgent(saved);
}

async function deleteAgent() {
  const id = $('#agent-form').elements.id.value;
  if (!id || !window.confirm('Delete this agent? Its runs are kept.')) return;
  await api(`/api/agents/${id}`, { method: 'DELETE' });
  editAgent(null);
}

async function runAgent(evt) {
  evt.preventDefault();
  const f = $('#run-form');
  const agentId = f.elements.agent.value;
  if (!agentId) { toast('Create an enabled agent first.'); return; }
  const btn = $('#run-btn');
  btn.disabled = true;
  btn.firstChild.textContent = 'Running… ';
  try {
    const run = await api(`/api/agents/${agentId}/runs`, { method: 'POST', body: { prompt: f.elements.prompt.value } });
    const box = $('#run-result');
    box.hidden = false;
    $('.run-meta', box).replaceChildren(
      el('span', { class: `status ${run.status}`, text: run.status }),
      el('span', { text: run.model }),
      el('span', { text: `in ${fmt.int(run.input_tokens)} · out ${fmt.int(run.output_tokens)}` }),
      el('span', { text: `cache read ${fmt.int(run.cache_read_tokens)} · write ${fmt.int(run.cache_write_tokens)}` }),
      el('span', { text: fmt.usd(run.cost_usd) }),
      el('span', { text: fmt.ms(run.latency_ms) }),
    );
    $('.output', box).textContent = run.error || run.output || `(no text; stop reason: ${run.stop_reason})`;
  } finally {
    btn.disabled = false;
    btn.firstChild.textContent = 'Run ';
  }
}

async function renderRuns() {
  const runs = await api('/api/runs?limit=200');
  const body = $('#runs-table tbody');
  body.replaceChildren(...(runs.length ? runs.map((r) => {
    const tr = el('tr', { title: r.error || r.prompt.slice(0, 200) },
      el('td', { text: fmt.when(r.created_at) }),
      el('td', { text: r.agent_name }),
      el('td', { text: r.model }),
      el('td', {}, el('span', { class: `status ${r.status}`, text: r.status })),
      el('td', { class: 'num', text: fmt.int(r.input_tokens) }),
      el('td', { class: 'num', text: fmt.int(r.output_tokens) }),
      el('td', { class: 'num', text: fmt.int(r.cache_read_tokens) }),
      el('td', { class: 'num', text: fmt.usd(r.cost_usd) }),
      el('td', { class: 'num', text: fmt.ms(r.latency_ms) }));
    return tr;
  }) : [el('tr', {}, el('td', { class: 'empty', colspan: '9', text: 'No runs yet.' }))]));
}

// ---- routing -----------------------------------------------------------------------------------

const VIEWS = { overview: renderOverview, agents: loadAgents, console: loadAgents, runs: renderRuns };

async function route() {
  const name = location.hash.replace('#/', '') || 'overview';
  const view = VIEWS[name] ? name : 'overview';
  for (const s of document.querySelectorAll('.view')) s.hidden = s.id !== `view-${view}`;
  for (const a of document.querySelectorAll('nav a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  try { await VIEWS[view](); } catch (e) { toast(e.message); }
}

async function init() {
  const guard = (fn) => (evt) => fn(evt).catch((e) => toast(e.message));
  $('#agent-form').addEventListener('submit', guard(saveAgent));
  $('#delete-agent').addEventListener('click', guard(deleteAgent));
  $('#new-agent').addEventListener('click', () => editAgent(null));
  $('#run-form').addEventListener('submit', guard(runAgent));
  $('#run-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#run-form').requestSubmit(); }
  });
  $('#refresh-runs').addEventListener('click', guard(renderRuns));
  $('#window').addEventListener('change', guard(renderOverview));
  window.addEventListener('hashchange', route);
  window.addEventListener('scroll', hideTip, { passive: true });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });

  try {
    const [health, models] = await Promise.all([api('/api/health'), api('/api/models')]);
    $('#provider').textContent = `provider: ${health.provider}`;
    state.models = models;
    $('#model-select').replaceChildren(...models.map((m) => el('option', { value: m.id, text: m.label })));
  } catch (e) {
    toast(e.message);
  }
  await route();
}

init();
