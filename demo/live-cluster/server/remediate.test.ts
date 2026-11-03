import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalysisOutcome, Decision } from './jevops.js';
import {
  ALERT_COOLDOWN_MS,
  evaluatePolicy,
  IncidentStore,
  VERIFY_DELAY_MS,
  type PolicyThresholds,
} from './remediate.js';

const THRESHOLDS: PolicyThresholds = { minConfidence: 0.85, minSeverity: 4, maxAttempts: 1 };

function outcome(pack: string, decisions: Record<string, Partial<Decision>>): AnalysisOutcome {
  const full: Record<string, Decision> = {};
  for (const [key, d] of Object.entries(decisions)) {
    full[key] = {
      type: d.type ?? 'choice',
      value: d.value ?? 'unknown',
      confidence: d.confidence ?? 0.99,
    };
  }
  return {
    pack,
    command: `jev-ops analyze ${pack} --json`,
    provider: 'mock',
    inputBytes: 1024,
    truncated: false,
    decisions: full,
    elapsedMs: 5,
    ok: true,
  };
}

function errored(pack: string): AnalysisOutcome {
  return { pack, command: 'x', ok: false, error: 'boom', elapsedMs: 1 };
}

function k8sCrashloop(confidence = 0.96, severity = 4): AnalysisOutcome {
  return outcome('kubernetes', {
    health: { value: 'unhealthy', confidence },
    root_cause: { value: 'crashloop', confidence },
    severity: { value: severity, type: 'score', confidence },
    needs_attention: { value: true, type: 'boolean', confidence },
  });
}

const k8sHealthy = outcome('kubernetes', {
  health: { value: 'healthy' },
  root_cause: { value: 'unknown' },
  severity: { value: 0, type: 'score' },
  needs_attention: { value: false, type: 'boolean' },
});

const appHealthy = outcome('demo-app', {
  health: { value: 'healthy' },
  root_cause: { value: 'normal' },
  severity: { value: 0, type: 'score' },
  needs_attention: { value: false, type: 'boolean' },
});

test('healthy packs → none', () => {
  const store = new IncidentStore();
  const d = evaluatePolicy([k8sHealthy, appHealthy], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'none');
  assert.equal(store.all().length, 0);
});

test('errored analyses → none (never act on errored input)', () => {
  const store = new IncidentStore();
  const d = evaluatePolicy([errored('kubernetes'), errored('demo-app')], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'none');
});

test('crashloop with high confidence and severity → remediate (delete-pods)', () => {
  const store = new IncidentStore();
  const d = evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'remediate');
  assert.equal(d.action, 'delete-pods');
  assert.equal(d.incidentKey, 'kubernetes:crashloop');
  assert.match(d.reason, /attempt 1\/1/);
  assert.equal(d.snapshot?.confidence, 0.96);
  // The attempt is recorded at decision time.
  assert.equal(store.get('kubernetes:crashloop')?.attempts, 1);
});

test('same incident right after the attempt → none (still verifying, no flapping)', () => {
  const store = new IncidentStore();
  evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, 1000);
  const d = evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, 1000 + 5_000);
  assert.equal(d.kind, 'none');
  assert.match(d.reason, /verifying/);
});

test('same incident after the verify window → escalate (remediation ineffective)', () => {
  const store = new IncidentStore();
  evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, 1000);
  const d = evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, 1000 + VERIFY_DELAY_MS + 1);
  assert.equal(d.kind, 'escalate');
  assert.match(d.reason, /remediation ineffective/);
  assert.ok(store.get('kubernetes:crashloop')?.lastAlertAt);
});

test('a repeated escalation within the cooldown → none', () => {
  const store = new IncidentStore();
  const t0 = 1_000;
  evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, t0);
  const first = evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, t0 + VERIFY_DELAY_MS + 1);
  assert.equal(first.kind, 'escalate');
  const second = evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, t0 + VERIFY_DELAY_MS + 2_000);
  assert.equal(second.kind, 'none');
  assert.match(second.reason, /cooldown/);
  // …but the cooldown expires and it escalates again.
  const third = evaluatePolicy(
    [k8sCrashloop(), appHealthy],
    store,
    THRESHOLDS,
    t0 + VERIFY_DELAY_MS + ALERT_COOLDOWN_MS + 2_000,
  );
  assert.equal(third.kind, 'escalate');
});

test('healthy after a remediation closes the incident (no later escalation)', () => {
  const store = new IncidentStore();
  evaluatePolicy([k8sCrashloop(), appHealthy], store, THRESHOLDS, 1000);
  const d = evaluatePolicy([k8sHealthy, appHealthy], store, THRESHOLDS, 1000 + 30_000);
  assert.equal(d.kind, 'none');
  assert.equal(store.all().length, 0);
});

test('confidence below the threshold → none', () => {
  const store = new IncidentStore();
  const d = evaluatePolicy([k8sCrashloop(0.5), appHealthy], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'none');
  assert.match(d.reason, /below the action threshold/);
  assert.equal(store.all().length, 0);
});

test('severity below the gate → none', () => {
  const store = new IncidentStore();
  const d = evaluatePolicy([k8sCrashloop(0.96, 2), appHealthy], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'none');
  assert.match(d.reason, /below severity gate/);
  assert.equal(store.all().length, 0);
});

test('non-fixable kubernetes root cause → escalate (no safe action)', () => {
  const store = new IncidentStore();
  const scheduling = outcome('kubernetes', {
    health: { value: 'unhealthy' },
    root_cause: { value: 'scheduling', confidence: 0.99 },
    severity: { value: 4, type: 'score' },
    needs_attention: { value: true, type: 'boolean' },
  });
  const d = evaluatePolicy([scheduling, appHealthy], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'escalate');
  assert.match(d.reason, /no safe automated action/);
  assert.equal(d.snapshot?.rootCause, 'scheduling');
});

test('app-level failure (boom / errors_5xx) → escalate "no safe cluster action"', () => {
  const store = new IncidentStore();
  const boom = outcome('demo-app', {
    health: { value: 'unhealthy' },
    root_cause: { value: 'errors_5xx', confidence: 0.93 },
    severity: { value: 3, type: 'score' },
    needs_attention: { value: true, type: 'boolean', confidence: 0.93 },
  });
  const d = evaluatePolicy([k8sHealthy, boom], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'escalate');
  assert.match(d.reason, /no safe cluster action/);
  assert.equal(d.incidentKey, 'demo-app:errors_5xx');
});

test('app-level crashloop is owned by the kubernetes pack → none', () => {
  const store = new IncidentStore();
  const appCrash = outcome('demo-app', {
    health: { value: 'unhealthy' },
    root_cause: { value: 'crashloop', confidence: 0.97 },
    severity: { value: 4, type: 'score' },
    needs_attention: { value: true, type: 'boolean' },
  });
  const d = evaluatePolicy([k8sHealthy, appCrash], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'none');
  assert.match(d.reason, /covered by the kubernetes pack/);
  assert.equal(store.all().length, 0);
});

test('remediate beats escalate: k8s crash wins over the app pack reading the same fault', () => {
  const store = new IncidentStore();
  const appCrash = outcome('demo-app', {
    health: { value: 'unhealthy' },
    root_cause: { value: 'crashloop', confidence: 0.97 },
    severity: { value: 4, type: 'score' },
    needs_attention: { value: true, type: 'boolean' },
  });
  const d = evaluatePolicy([k8sCrashloop(), appCrash], store, THRESHOLDS, 1000);
  assert.equal(d.kind, 'remediate');
});
