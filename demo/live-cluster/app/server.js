#!/usr/bin/env node
// Demo application for the jev-ops live-cluster demo.
//
// Small HTTP service (zero dependencies, Node builtins only) that simulates a
// realistic web API with operator-controllable failure modes:
//
//   GET /health -> 200 always (liveness/readiness probe target)
//   GET /       -> normal traffic; structured JSON logs on stdout
//   GET /boom   -> switch to error mode: 500s + DB errors + latency spikes
//   GET /crash  -> persist a crash flag, then exit(1) -> CrashLoopBackOff
//   GET /oom    -> persist an oom flag, then allocate until the cgroup OOM-kills us
//   GET /reset  -> clear any persisted fault flag and return to normal
//
// "crash" and "oom" survive container restarts via a flag file in the
// container's writable layer (/tmp/fault), so the pod keeps failing until
// /reset clears it (or the pod is deleted).
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.PORT || 3000);
const POD_NAME = process.env.POD_NAME || os.hostname();
// Persisted via a pod-level emptyDir (k8s/deployment.yaml) so fault flags survive
// container restarts reliably (the container's overlay upperdir is not stable
// across in-place restarts) and are cleared when the pod is recreated.
const FAULT_FILE = '/var/fault/flag';

let mode = 'normal'; // 'normal' | 'boom'
let oomChunks = [];

// ---------------------------------------------------------------------------
// Logging: one JSON line per event, the shape jev-ops packs are tuned for.
// ---------------------------------------------------------------------------
function log(level, msg, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pod: POD_NAME,
    level,
    msg,
    ...extra,
  });
  process.stdout.write(line + '\n');
}

// Every 5s the app writes to stdout so the demo always has fresh logs to show.
// In 'boom' mode the heartbeat simulates a burst of failing traffic.
function heartbeat() {
  if (mode === 'boom') {
    log('error', 'request failed', {
      path: '/api/orders',
      status: 500,
      latency_ms: 1800 + Math.floor(Math.random() * 900),
      error: 'ECONNREFUSED connect 10.96.0.15:5432',
    });
    log('warn', 'connection pool exhausted', { pool_size: 10, waiting: 23 });
    log('error', 'db connection failed', {
      error: 'timeout expired',
      stack:
        'Error: timeout expired\n    at Pool.query (/app/server.js:1:1)\n    at async handler (/app/server.js:1:1)',
    });
    return;
  }
  if (mode === 'oom') {
    log('warn', 'memory pressure', {
      rss_mb: Math.round(process.memoryUsage().rss / 1048576),
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576),
    });
    return;
  }
  log('info', 'heartbeat', { mode, uptime_s: Math.round(process.uptime()) });
}

// ---------------------------------------------------------------------------
// Fault modes
// ---------------------------------------------------------------------------
function persistFault(kind) {
  fs.writeFileSync(FAULT_FILE, kind);
  mode = kind;
  log('error', 'fault injected', { kind });
}

function clearFault() {
  try {
    fs.unlinkSync(FAULT_FILE);
  } catch {
    /* no flag present */
  }
  mode = 'normal';
  oomChunks = [];
  log('info', 'fault cleared, back to normal', {});
}

function dieInCrashLoop() {
  log('error', 'fatal: unhandled exception', {
    error: "TypeError: Cannot read properties of undefined (reading 'id')",
    stack:
      'TypeError: Cannot read properties of undefined (reading \'id\')\n    at /app/server.js:1:1\n    at Layer.handle (/app/server.js:1:1)',
  });
  log('error', 'process exiting with code 1', {});
  process.exit(1);
}

function startOomAllocator() {
  const CHUNK_BYTES = 64 * 1024 * 1024; // 64 MiB per allocation
  const timer = setInterval(() => {
    try {
      // allocUnsafe only reserves address space (overcommit): the kernel never
      // commits the pages, so RSS stays flat and the cgroup never OOM-kills.
      // fill(1) forces page commit -> real RSS growth -> OOMKilled (exit 137).
      const chunk = Buffer.alloc(CHUNK_BYTES);
      chunk.fill(1);
      oomChunks.push(chunk);
      log('warn', 'memory pressure', {
        rss_mb: Math.round(process.memoryUsage().rss / 1048576),
        chunks: oomChunks.length,
      });
    } catch (err) {
      log('error', 'allocation failed', { error: String(err && err.message) });
    }
  }, 400);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function handleRequest(req, res) {
  const path = (req.url || '/').split('?')[0];

  if (path === '/health') {
    return respond(res, 200, { status: 'ok', mode });
  }

  if (path === '/reset') {
    clearFault();
    return respond(res, 200, { status: 'ok', mode: 'normal' });
  }

  if (path === '/boom') {
    persistFault('boom');
    return respond(res, 200, { status: 'fault-injected', mode: 'boom' });
  }

  if (path === '/crash') {
    persistFault('crash');
    respond(res, 200, { status: 'fault-injected', mode: 'crash' });
    setTimeout(dieInCrashLoop, 150);
    return;
  }

  if (path === '/oom') {
    persistFault('oom');
    respond(res, 200, { status: 'fault-injected', mode: 'oom' });
    setTimeout(startOomAllocator, 150);
    return;
  }

  // Root: simulated request traffic.
  if (mode === 'boom') {
    const latency = 1200 + Math.floor(Math.random() * 1500);
    log('error', 'request failed', {
      path,
      status: 500,
      latency_ms: latency,
      error: 'ECONNREFUSED connect 10.96.0.15:5432',
    });
    return respond(res, 500, { error: 'upstream database unavailable' });
  }

  const slow = Math.random() < 0.03;
  const latency = slow ? 800 + Math.floor(Math.random() * 1200) : 4 + Math.floor(Math.random() * 60);
  log('info', 'request completed', { path, status: 200, latency_ms: latency });
  if (slow) {
    log('warn', 'slow query', { query: 'SELECT * FROM orders WHERE user_id=$1', latency_ms: latency });
  }
  return respond(res, 200, { ok: true, path, slow });
}

// ---------------------------------------------------------------------------
// Boot: honour a persisted fault flag (crash loops / OOM loops survive restarts).
// ---------------------------------------------------------------------------
if (fs.existsSync(FAULT_FILE)) {
  const persisted = fs.readFileSync(FAULT_FILE, 'utf8').trim();
  log('warn', 'persisted fault flag found on boot', { kind: persisted });
  if (persisted === 'crash') {
    mode = 'crash';
    setTimeout(dieInCrashLoop, 100);
  } else if (persisted === 'oom') {
    mode = 'oom';
    startOomAllocator();
  }
}

const server = http.createServer(handleRequest);
setInterval(heartbeat, 5000);
server.listen(PORT, () => {
  log('info', 'server listening', { port: PORT });
});