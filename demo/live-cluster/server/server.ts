import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  getContext,
  getDeployment,
  getLogs,
  getPods,
  getWarningEvents,
  KubectlError,
  podBreakdown,
  podState,
} from './kubectl.js';
import { buildPodSummaryLines, collectAppInput, collectK8sInput, formatEvents } from './collector.js';
import { analyze } from './jevops.js';
import { FAULT_MODES, triggerFault, type FaultMode } from './faults.js';

const cfg = loadConfig();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.normalize(path.join(publicDir, rel));
  // Whitelist: only direct children of public/ with a known extension.
  if (!abs.startsWith(publicDir + path.sep)) return false;
  const ext = path.extname(abs);
  if (!MIME[ext]) return false;
  try {
    const data = fs.readFileSync(abs);
    res.writeHead(200, { 'Content-Type': MIME[ext] });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function handleStatus(): Promise<{ status: number; body: unknown }> {
  const [deployment, pods, context] = await Promise.all([
    getDeployment(cfg).catch((e: unknown) => {
      throw e;
    }),
    getPods(cfg),
    getContext(cfg),
  ]);
  const breakdown = podBreakdown(pods);
  return {
    status: 200,
    body: {
      context,
      namespace: cfg.namespace,
      deployment: {
        name: deployment.name,
        replicas: deployment.replicas,
        readyReplicas: deployment.readyReplicas,
      },
      pods: {
        ...breakdown,
        list: pods.map((p) => ({ name: p.name, state: podState(p) })),
      },
    },
  };
}

async function handleLogs(kind: string): Promise<{ status: number; body: unknown }> {
  if (kind === 'app') {
    const raw = await getLogs(cfg, 60);
    const lines = raw.split('\n').filter((l) => l.trim().length > 0).slice(-60);
    return { status: 200, body: { kind, lines, ts: new Date().toISOString() } };
  }
  if (kind === 'k8s') {
    const [events, pods] = await Promise.all([getWarningEvents(cfg, 25, cfg.eventsWindowMinutes), getPods(cfg)]);
    const lines = [...formatEvents(events), ...buildPodSummaryLines(pods)].slice(-40);
    return { status: 200, body: { kind, lines, ts: new Date().toISOString() } };
  }
  return { status: 400, body: { error: "kind must be 'app' or 'k8s'" } };
}

async function handleAnalyze(): Promise<{ status: number; body: unknown }> {
  const [app, k8s, context] = await Promise.all([collectAppInput(cfg), collectK8sInput(cfg), getContext(cfg)]);
  const outcomes = await Promise.all([
    analyze({
      bin: cfg.jevopsBin,
      packDir: cfg.packDir,
      apiKey: cfg.typesafeApiKey,
      provider: cfg.provider,
      pack: app.pack,
      input: app.input,
      command: app.command,
    }),
    analyze({
      bin: cfg.jevopsBin,
      packDir: cfg.packDir,
      apiKey: cfg.typesafeApiKey,
      provider: cfg.provider,
      pack: k8s.pack,
      input: k8s.input,
      command: k8s.command,
    }),
  ]);
  return {
    status: 200,
    body: { ts: new Date().toISOString(), cluster: { context, namespace: cfg.namespace }, analyses: outcomes },
  };
}

async function handleFault(mode: unknown): Promise<{ status: number; body: unknown }> {
  if (typeof mode !== 'string' || !(FAULT_MODES as readonly string[]).includes(mode)) {
    return { status: 400, body: { error: `mode must be one of: ${FAULT_MODES.join(', ')}` } };
  }
  const result = await triggerFault(cfg, mode as FaultMode);
  return { status: 200, body: { ok: true, ...result } };
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
  const method = req.method ?? 'GET';

  if (urlPath === '/api/config' && method === 'GET') {
    sendJson(res, 200, {
      hasApiKey: cfg.typesafeApiKey !== null,
      jevopsBin: cfg.jevopsBin,
      packDir: cfg.packDir,
      analyzeTail: cfg.analyzeTail,
    });
    return;
  }

  if (urlPath === '/api/status' && method === 'GET') {
    handleStatus()
      .then((r) => sendJson(res, r.status, r.body))
      .catch((e: unknown) => sendJson(res, 503, { error: message(e), hint: 'is kubectl reachable and is the cluster up?' }));
    return;
  }

  if (urlPath === '/api/logs' && method === 'GET') {
    const kind = new URL(req.url ?? '/', 'http://localhost').searchParams.get('kind') ?? 'app';
    handleLogs(kind)
      .then((r) => sendJson(res, r.status, r.body))
      .catch((e: unknown) => sendJson(res, 503, { error: message(e) }));
    return;
  }

  if (urlPath === '/api/analyze' && method === 'POST') {
    readBody(req)
      .then(() => handleAnalyze())
      .then((r) => sendJson(res, r.status, r.body))
      .catch((e: unknown) => {
        if (e instanceof KubectlError) sendJson(res, 503, { error: message(e) });
        else if (e instanceof Error && e.message === 'body too large') sendJson(res, 413, { error: 'request body too large' });
        else sendJson(res, 400, { error: message(e) });
      });
    return;
  }

  if (urlPath === '/api/fault' && method === 'POST') {
    readBody(req)
      .then((body) => handleFault((body as { mode?: unknown } | null)?.mode))
      .then((r) => sendJson(res, r.status, r.body))
      .catch((e: unknown) => sendJson(res, 502, { error: message(e) }));
    return;
  }

  if (method === 'GET' && serveStatic(req, res)) return;

  sendJson(res, 404, { error: 'not found' });
});

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

server.listen(cfg.port, () => {
  const lines = [
    `jev-ops live-cluster demo listening on http://localhost:${cfg.port}`,
    `  jev-ops binary: ${cfg.jevopsBin} (pack dir: ${cfg.packDir})`,
  ];
  if (!cfg.typesafeApiKey) {
    lines.push('  ⚠ TYPESAFE_API_KEY is not set — /api/analyze will fail (jev-ops exits 5 without it).');
  }
  getContext(cfg)
    .then((ctx) => lines.push(`  kubectl context: ${ctx ?? '(none — cluster unreachable)'}`))
    .catch(() => lines.push('  kubectl context: (none — cluster unreachable)'))
    .finally(() => console.log(lines.join('\n')));
});