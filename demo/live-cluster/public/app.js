/* jev-ops live-cluster demo — zero dependencies, poll-based dashboard. */

const POLL_MS = 2000;
const LOG_BUFFER = 60;

const $ = (id) => document.getElementById(id);
const state = {
  logKind: 'app',
  appLogs: [],
  k8sLogs: [],
  analysing: false,
};

const DECISION_LABELS = {
  health: 'Health',
  root_cause: 'Root cause',
  severity: 'Severity',
  needs_attention: 'Attention',
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function active(el) {
  el.classList.add('active');
}

function deactive(el) {
  el.classList.remove('active');
}

function badgeClass(value) {
  const v = String(value).toLowerCase();
  if (['healthy', 'normal', 'running', 'no', 'promote', 'pass'].includes(v)) return 'good';
  if (['degraded', 'warning', 'starting'].includes(v)) return 'warn';
  return 'bad';
}

function severityClass(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return 'warn';
  if (n <= 1) return 'good';
  if (n <= 3) return 'warn';
  return 'bad';
}

// ---------------------------------------------------------------------------
// Status pill + pod squares
// ---------------------------------------------------------------------------
async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const statusPill = $('statusPill');
    statusPill.textContent = `cluster OK · ${data.context ?? '?'}`;
    statusPill.dataset.state = 'ok';
    $('contextPill').textContent = `ns/${data.namespace} · deploy/${data.deployment.name}`;
    $('replicasPill').textContent = `replicas ${data.deployment.readyReplicas}/${data.deployment.replicas}`;
    $('replicasPill').dataset.state =
      data.deployment.readyReplicas === data.deployment.replicas && data.deployment.replicas > 0
        ? 'ok'
        : 'bad';

    renderPods(data.pods.list ?? []);
  } catch {
    $('statusPill').textContent = 'cluster DOWN';
    $('statusPill').dataset.state = 'bad';
  }
}

function renderPods(pods) {
  const grid = $('podsGrid');
  if (!pods.length) {
    grid.innerHTML = '<div class="empty">no pods yet</div>';
    return;
  }
  grid.innerHTML = pods
    .map((p) => {
      const name = p.name.replace(/^demo-app-/, '');
      return `<div class="pod" title="${escapeHtml(p.name)}">
        <span class="sq ${p.state}"></span>
        <span class="pod-name">${escapeHtml(name)}</span>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Log panes
// ---------------------------------------------------------------------------
async function pollLogs() {
  for (const kind of ['app', 'k8s']) {
    try {
      const res = await fetch(`/api/logs?kind=${kind}`);
      if (!res.ok) continue;
      const data = await res.json();
      // App logs arrive chronological (oldest first) — render newest at the top.
      state[kind === 'app' ? 'appLogs' : 'k8sLogs'] = data.lines.slice(-LOG_BUFFER);
      if (kind === 'app') state.appLogs = state.appLogs.slice().reverse();
    } catch {
      /* cluster down; keep last buffer */
    }
  }
  renderLogs();
}

function renderLogs() {
  const pane = $('logPane');
  const lines = state.logKind === 'app' ? state.appLogs : state.k8sLogs;
  if (!lines.length) {
    pane.innerHTML = '<div class="empty">no log lines yet</div>';
    return;
  }
  const className = state.logKind === 'app' ? 'log-line' : 'ev-line';
  pane.innerHTML = lines.map((l) => `<div class="${className}">${escapeHtml(l)}</div>`).join('');
  pane.scrollTop = 0; // newest lines are rendered at the top
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------
async function analyze() {
  if (state.analysing) return;
  state.analysing = true;
  const btn = $('analyzeBtn');
  btn.disabled = true;
  btn.textContent = '⚡ Jev is reading the logs…';
  activity('⚡ analyzing app logs + cluster state (live TypeSafe Jev)');

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok) {
      renderVerdictError(data.error ?? `HTTP ${res.status}`);
    } else {
      renderVerdicts(data.analyses ?? []);
      const commands = (data.analyses ?? [])
        .map((a) => `# ${a.pack}\n$ ${a.command}`)
        .join('\n\n');
      $('lastCommand').textContent = commands;
    }
    $('verdictTs').textContent = new Date(data.ts ?? Date.now()).toLocaleTimeString();
  } catch (err) {
    renderVerdictError(String(err));
  } finally {
    state.analysing = false;
    btn.disabled = false;
    btn.textContent = '⚡ Analyze now';
  }
}

function decisionChip(d) {
  if (!d) return '';
  let value = d.value;
  let cls = badgeClass(value);
  let display = escapeHtml(String(value));
  if (d.type === 'score') {
    cls = severityClass(value);
    display = `${escapeHtml(String(value))}/5`;
  }
  if (d.type === 'boolean') {
    display = value ? 'yes' : 'no';
    cls = value ? 'bad' : 'good';
  }
  const confidence = Math.round((d.confidence ?? 0) * 100);
  const bar = `<div class="meter"><div class="meter-fill ${cls}" style="width:${confidence}%"></div></div>`;
  return `<div class="decision">
    <div class="decision-top"><span class="decision-name">${DECISION_LABELS[d.key] ?? escapeHtml(d.key)}</span><span class="chip ${cls}">${display}</span></div>
    <div class="decision-meta">${confidence}% confidence</div>
    ${bar}
  </div>`;
}

function renderVerdicts(analyses) {
  const container = $('verdicts');
  container.innerHTML = analyses
    .map((a) => {
      if (!a.ok) {
        return `<div class="verdict-card error">
          <div class="card-head">${escapeHtml(a.pack)} pack <span class="chip bad">error</span>
            <span class="dim">in ${a.elapsedMs}ms</span></div>
          <div class="err-msg">${escapeHtml(a.error)}</div>
        </div>`;
      }
      const decisions = Object.entries(a.decisions ?? {}).map(([key, d]) => ({ key, ...d }));
      const chips = decisions.map(decisionChip).join('');
      return `<div class="verdict-card">
        <div class="card-head">${escapeHtml(a.pack)} pack
          <span class="chip ${a.ok ? 'good' : 'bad'}">${escapeHtml(a.provider)}</span>
          <span class="dim">${(a.inputBytes / 1024).toFixed(1)} KB · ${a.elapsedMs}ms</span></div>
        <div class="decisions">${chips}</div>
      </div>`;
    })
    .join('');
}

function renderVerdictError(message) {
  $('verdicts').innerHTML = `<div class="verdict-card error">
    <div class="card-head">analysis failed <span class="chip bad">error</span></div>
    <div class="err-msg">${escapeHtml(message)}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------
async function fault(mode) {
  try {
    const res = await fetch('/api/fault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    activity(`🛠 ${mode}: ${data.detail}${data.podUsed ? ` (${data.podUsed})` : ''}`);
  } catch (err) {
    activity(`❌ ${mode} failed: ${err.message}`);
  }
}

function activity(text) {
  const log = $('activityLog');
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  log.prepend(line);
  while (log.children.length > 8) log.lastChild.remove();
}

// ---------------------------------------------------------------------------
// Config pill (API key presence, jev-ops binary)
// ---------------------------------------------------------------------------
async function pollConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const pill = $('jevPill');
    if (data.hasApiKey) {
      pill.textContent = `Jev live · ${data.jevopsBin}`;
      pill.dataset.state = 'ok';
    } else {
      pill.textContent = 'Jev: no API key — analyze will fail';
      pill.dataset.state = 'bad';
    }
  } catch {
    $('jevPill').textContent = 'jev …';
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.querySelectorAll('.fault-row .btn').forEach((btn) => {
  btn.addEventListener('click', () => fault(btn.dataset.mode));
});
$('analyzeBtn').addEventListener('click', analyze);
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.logKind = tab.dataset.kind;
    renderLogs();
  });
});

setInterval(pollStatus, POLL_MS);
setInterval(pollLogs, POLL_MS);
pollStatus();
pollLogs();
pollConfig();
setInterval(pollConfig, 10_000);