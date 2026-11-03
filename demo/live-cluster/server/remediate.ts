import type { AnalysisOutcome, AnalysisResult, Decision } from './jevops.js';

/**
 * Pure auto-remediation policy: typed Jev decisions in, bounded actions out.
 *
 * The autopilot acts on the *kubernetes* pack only (infrastructure), and the
 * single action it knows is `delete-pods` — a pod restart. Application-level
 * root causes (errors_5xx, db_connection, …) have no safe cluster action, so
 * they escalate to a human instead of flailing.
 *
 * Everything here is pure/in-memory: no kubectl, no fetch, no timers — the IO
 * lives in autopilot.ts. That keeps the full policy matrix unit-testable.
 */

export const K8S_PACK = 'kubernetes';
export const APP_PACK = 'demo-app';

/** kubernetes-pack root causes the autopilot is allowed to act on. */
export const K8S_AUTO_FIXABLE = new Set(['crashloop', 'resources']);
/** demo-app-pack root causes cured by the pod delete the k8s pack triggers. */
export const APP_SELF_REMEDIATED = new Set(['crashloop', 'oom_killed']);

/** Minimum time between a remediation attempt and declaring it ineffective. */
export const VERIFY_DELAY_MS = 60_000;
/** Minimum time between two escalations of the same incident. */
export const ALERT_COOLDOWN_MS = 90_000;

export type RemediationAction = 'delete-pods';

export interface PolicyThresholds {
  minConfidence: number; // 0..1, applied to every decision we branch on
  minSeverity: number; // 0..5, kubernetes pack gate
  maxAttempts: number; // remediation attempts per incident before escalating
}

/** The Jev signal that triggered a decision, for the UI/alert feed. */
export interface DecisionSnapshot {
  pack: string;
  rootCause: string;
  severity: number | null;
  needsAttention: boolean;
  confidence: number; // lowest confidence among the decisions we branched on
}

export interface RemediationDecision {
  kind: 'none' | 'remediate' | 'escalate';
  reason: string;
  action?: RemediationAction;
  incidentKey?: string;
  snapshot?: DecisionSnapshot;
}

/** One open (or recently remediated) incident, keyed `<pack>:<root_cause>`. */
export interface Incident {
  key: string;
  pack: string;
  rootCause: string;
  attempts: number;
  lastActionAt: number | null;
  lastAlertAt: number | null;
}

/** In-memory incident ledger. A server restart resets it — on purpose. */
export class IncidentStore {
  private readonly incidents = new Map<string, Incident>();

  get(key: string): Incident | undefined {
    return this.incidents.get(key);
  }

  recordAction(key: string, pack: string, rootCause: string, now: number): Incident {
    const incident = this.ensure(key, pack, rootCause);
    incident.attempts += 1;
    incident.lastActionAt = now;
    return incident;
  }

  recordAlert(key: string, pack: string, rootCause: string, now: number): Incident {
    const incident = this.ensure(key, pack, rootCause);
    incident.lastAlertAt = now;
    return incident;
  }

  /** Drop every incident of a pack that reported healthy on this cycle. */
  resolvePack(pack: string): string[] {
    const closed: string[] = [];
    for (const [key, incident] of this.incidents) {
      if (incident.pack === pack) {
        closed.push(key);
        this.incidents.delete(key);
      }
    }
    return closed;
  }

  all(): Incident[] {
    return [...this.incidents.values()];
  }

  private ensure(key: string, pack: string, rootCause: string): Incident {
    let incident = this.incidents.get(key);
    if (!incident) {
      incident = { key, pack, rootCause, attempts: 0, lastActionAt: null, lastAlertAt: null };
      this.incidents.set(key, incident);
    }
    return incident;
  }
}

function okResult(outcome: AnalysisOutcome | undefined): AnalysisResult | null {
  return outcome && outcome.ok ? outcome : null;
}

/** Lowest confidence across the given decisions; missing decisions drag it to 0. */
function minConfidence(decisions: Array<Decision | undefined>): number {
  if (decisions.some((d) => !d)) return 0;
  return Math.min(...decisions.map((d) => (d as Decision).confidence));
}

function pct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function snapshotOf(
  pack: string,
  rootCause: string,
  severity: number | null,
  needsAttention: boolean,
  confidence: number,
): DecisionSnapshot {
  return { pack, rootCause, severity, needsAttention, confidence };
}

function escalateOrCooldown(
  store: IncidentStore,
  key: string,
  pack: string,
  rootCause: string,
  reason: string,
  snapshot: DecisionSnapshot,
  now: number,
): RemediationDecision {
  const incident = store.get(key);
  if (incident?.lastAlertAt != null && now - incident.lastAlertAt < ALERT_COOLDOWN_MS) {
    return { kind: 'none', reason: `already escalated ${key} ${Math.round((now - incident.lastAlertAt) / 1000)}s ago — alert cooldown`, incidentKey: key };
  }
  store.recordAlert(key, pack, rootCause, now);
  return { kind: 'escalate', reason, incidentKey: key, snapshot };
}

/**
 * Evaluates one analysis cycle against the policy. Side effects on `store`:
 * records remediation attempts and escalation timestamps, and closes incidents
 * whose pack reports healthy — all keyed to `now`.
 */
export function evaluatePolicy(
  outcomes: AnalysisOutcome[],
  store: IncidentStore,
  thresholds: PolicyThresholds,
  now: number = Date.now(),
): RemediationDecision {
  const k8s = okResult(outcomes.find((o) => o.pack === K8S_PACK));
  const app = okResult(outcomes.find((o) => o.pack === APP_PACK));

  if (!k8s && !app) {
    return { kind: 'none', reason: 'no successful analysis this cycle — autopilot never acts on errored input' };
  }

  // Close incidents for packs that are back to healthy before looking for
  // new triggers, so a resolved crashloop never escalates afterwards.
  for (const [pack, result] of [
    [K8S_PACK, k8s],
    [APP_PACK, app],
  ] as const) {
    if (result && result.decisions.health?.value === 'healthy') {
      store.resolvePack(pack);
    }
  }

  const k8sDecision = k8s ? evaluateKubernetes(k8s, store, thresholds, now) : null;
  if (k8sDecision && k8sDecision.kind !== 'none') return k8sDecision;

  const appDecision = app ? evaluateApp(app, store, thresholds, now) : null;
  if (appDecision && appDecision.kind !== 'none') return appDecision;

  if (k8s && app && k8s.decisions.health?.value === 'healthy' && app.decisions.health?.value === 'healthy') {
    return { kind: 'none', reason: 'all quiet — both packs healthy' };
  }
  // Both quiet on actions but something was flagged: the informative "none"
  // (a gated/owned decision) carries a snapshot; the generic healthy one does
  // not. Prefer it so the UI shows *why* nothing was done.
  const informative = [k8sDecision, appDecision].find((d) => d?.snapshot);
  return informative ?? k8sDecision ?? appDecision ?? { kind: 'none', reason: 'all quiet' };
}

function evaluateKubernetes(
  result: AnalysisResult,
  store: IncidentStore,
  thresholds: PolicyThresholds,
  now: number,
): RemediationDecision {
  const d = result.decisions;
  const needsAttention = d.needs_attention?.value === true;
  const severity = Number(d.severity?.value);
  const rootCause = String(d.root_cause?.value ?? 'unknown');
  const confidence = minConfidence([d.needs_attention, d.severity, d.root_cause]);

  if (!needsAttention) {
    return { kind: 'none', reason: 'kubernetes pack needs no attention' };
  }

  const key = `${K8S_PACK}:${rootCause}`;
  const snapshot = snapshotOf(K8S_PACK, rootCause, Number.isNaN(severity) ? null : severity, true, confidence);

  if (!K8S_AUTO_FIXABLE.has(rootCause)) {
    return escalateOrCooldown(
      store,
      key,
      K8S_PACK,
      rootCause,
      `kubernetes pack: root_cause=${rootCause} with needs_attention=yes, but there is no safe automated action for it — paging a human`,
      snapshot,
      now,
    );
  }

  if (Number.isNaN(severity) || severity < thresholds.minSeverity) {
    return {
      kind: 'none',
      reason: `kubernetes pack: ${rootCause} below severity gate (${Number.isNaN(severity) ? 'n/a' : severity} < ${thresholds.minSeverity}) — watching, not acting`,
      snapshot,
    };
  }

  if (confidence < thresholds.minConfidence) {
    return {
      kind: 'none',
      reason: `kubernetes pack: ${rootCause} at ${pct(confidence)} confidence (< ${pct(thresholds.minConfidence)}) — below the action threshold`,
      snapshot,
    };
  }

  const incident = store.get(key);
  const attempts = incident?.attempts ?? 0;

  if (attempts >= thresholds.maxAttempts) {
    const lastActionAt = incident?.lastActionAt ?? 0;
    if (now - lastActionAt < VERIFY_DELAY_MS) {
      return {
        kind: 'none',
        reason: `remediation attempt ${attempts}/${thresholds.maxAttempts} for ${rootCause} still settling — verifying before escalating`,
        incidentKey: key,
        snapshot,
      };
    }
    return escalateOrCooldown(
      store,
      key,
      K8S_PACK,
      rootCause,
      `kubernetes pack: still needs_attention (${rootCause}, severity ${severity}/5) after ${attempts} remediation attempt(s) — remediation ineffective, paging a human`,
      snapshot,
      now,
    );
  }

  store.recordAction(key, K8S_PACK, rootCause, now);
  return {
    kind: 'remediate',
    action: 'delete-pods',
    reason: `kubernetes pack: needs_attention=yes, severity ${severity}/5, root_cause=${rootCause} at ${pct(confidence)} confidence — deleting pods (attempt ${attempts + 1}/${thresholds.maxAttempts})`,
    incidentKey: key,
    snapshot,
  };
}

function evaluateApp(
  result: AnalysisResult,
  store: IncidentStore,
  thresholds: PolicyThresholds,
  now: number,
): RemediationDecision {
  const d = result.decisions;
  const needsAttention = d.needs_attention?.value === true;
  const severity = d.severity ? Number(d.severity.value) : null;
  const rootCause = String(d.root_cause?.value ?? 'unknown');
  const confidence = minConfidence([d.needs_attention, d.root_cause]);

  if (!needsAttention) {
    return { kind: 'none', reason: 'demo-app pack needs no attention' };
  }

  if (APP_SELF_REMEDIATED.has(rootCause)) {
    return {
      kind: 'none',
      reason: `demo-app pack: ${rootCause} is covered by the kubernetes pack's pod restart — no extra action`,
      snapshot: snapshotOf(APP_PACK, rootCause, severity, true, confidence),
    };
  }

  if (confidence < thresholds.minConfidence) {
    return {
      kind: 'none',
      reason: `demo-app pack: ${rootCause} at ${pct(confidence)} confidence (< ${pct(thresholds.minConfidence)}) — below the alert threshold`,
      snapshot: snapshotOf(APP_PACK, rootCause, severity, true, confidence),
    };
  }

  const key = `${APP_PACK}:${rootCause}`;
  return escalateOrCooldown(
    store,
    key,
    APP_PACK,
    rootCause,
    `demo-app pack: application failure (root_cause=${rootCause}, severity ${severity ?? 'n/a'}/5) has no safe cluster action — paging a human`,
    snapshotOf(APP_PACK, rootCause, severity, true, confidence),
    now,
  );
}
