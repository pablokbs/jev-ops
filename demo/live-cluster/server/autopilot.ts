import type { Config } from './config.js';
import { collectAppInput, collectK8sInput } from './collector.js';
import { analyze, type AnalysisOutcome } from './jevops.js';
import { deletePods, getContext } from './kubectl.js';
import {
  ALERT_COOLDOWN_MS,
  evaluatePolicy,
  IncidentStore,
  VERIFY_DELAY_MS,
  type DecisionSnapshot,
  type PolicyThresholds,
  type RemediationDecision,
} from './remediate.js';

/**
 * The autopilot: runs the collect → analyze → evaluatePolicy → act loop.
 *
 * Armed, it closes the loop on its own every `autopilotIntervalMs`; disarmed,
 * `/api/analyze` still runs the same pipeline but reports decisions with
 * kind 'none' (hands off the cluster). Everything is in-memory on purpose.
 */

const FEED_CAP = 50;
const SLACK_TIMEOUT_MS = 3_000;

/** One entry in the automation feed (dashboard panel + Slack source). */
export interface AutomationEvent {
  ts: string; // ISO
  kind: 'action' | 'alert' | 'info';
  text: string;
  detail?: string;
  snapshot?: DecisionSnapshot;
  slack?: 'sent' | 'failed' | 'not-configured';
}

/** What the policy decided for one analysis cycle (body of `automation`). */
export interface AutomationResult {
  armed: boolean;
  decision: RemediationDecision;
}

/** Response body shared by POST /api/analyze and the autopilot loop. */
export interface AnalysisResponse {
  ts: string;
  cluster: { context: string | null; namespace: string };
  analyses: AnalysisOutcome[];
  automation: AutomationResult;
}

export interface AutopilotPolicyView {
  action: 'delete-pods';
  minSeverity: number;
  minConfidence: number;
  maxAttempts: number;
  intervalMs: number;
  verifyDelayMs: number;
  alertCooldownMs: number;
}

export interface AutopilotState {
  armed: boolean;
  policy: AutopilotPolicyView;
  feed: AutomationEvent[];
}

/** Runs `fn` such that concurrent callers share one in-flight execution. */
export function serialized<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = fn().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

/** POSTs one text message to a Slack incoming webhook; never throws. */
export async function postSlack(webhookUrl: string | null, text: string): Promise<AutomationEvent['slack']> {
  if (!webhookUrl) return 'not-configured';
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

export class Autopilot {
  private readonly cfg: Config;
  private readonly store = new IncidentStore();
  private readonly thresholds: PolicyThresholds;
  private readonly feed: AutomationEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private armed: boolean;
  /** Public entry point is single-flight: manual Analyze and the loop never overlap. */
  readonly runOnce: () => Promise<AnalysisResponse>;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.thresholds = {
      minConfidence: cfg.autopilotMinConfidence,
      minSeverity: cfg.autopilotMinSeverity,
      maxAttempts: cfg.autopilotMaxAttempts,
    };
    this.armed = cfg.autopilotArmed;
    this.runOnce = serialized(() => this.runCycle());
    if (this.armed) {
      this.push('info', 'autopilot started ARMED (AUTOPILOT_ARMED)');
      this.startLoop();
    }
  }

  isArmed(): boolean {
    return this.armed;
  }

  setArmed(armed: boolean): void {
    if (armed === this.armed) return;
    this.armed = armed;
    if (armed) {
      this.push('info', 'autopilot ARMED — it can restart pods on high-confidence decisions');
      this.startLoop();
    } else {
      this.push('info', 'autopilot DISARMED — hands off the cluster');
      this.stopLoop();
    }
  }

  getState(): AutopilotState {
    return {
      armed: this.armed,
      policy: {
        action: 'delete-pods',
        minSeverity: this.thresholds.minSeverity,
        minConfidence: this.thresholds.minConfidence,
        maxAttempts: this.thresholds.maxAttempts,
        intervalMs: this.cfg.autopilotIntervalMs,
        verifyDelayMs: VERIFY_DELAY_MS,
        alertCooldownMs: ALERT_COOLDOWN_MS,
      },
      feed: this.feed.slice(0, FEED_CAP),
    };
  }

  private startLoop(): void {
    this.stopLoop();
    this.timer = setInterval(() => {
      this.runOnce().catch((err: unknown) => {
        this.push('info', `autopilot cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.cfg.autopilotIntervalMs);
    // Never let the loop keep the process (or a test run) alive by itself.
    this.timer.unref();
  }

  private stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private push(kind: AutomationEvent['kind'], text: string, extra: Partial<AutomationEvent> = {}): void {
    this.feed.unshift({ ts: new Date().toISOString(), kind, text, ...extra });
    if (this.feed.length > FEED_CAP) this.feed.length = FEED_CAP;
  }

  private async runCycle(): Promise<AnalysisResponse> {
    const cfg = this.cfg;
    const [app, k8s, context] = await Promise.all([collectAppInput(cfg), collectK8sInput(cfg), getContext(cfg)]);
    const outcomes = await Promise.all(
      [app, k8s].map((collected) =>
        analyze({
          bin: cfg.jevopsBin,
          packDir: cfg.packDir,
          apiKey: cfg.typesafeApiKey,
          provider: cfg.provider,
          pack: collected.pack,
          input: collected.input,
          command: collected.command,
        }),
      ),
    );

    let decision: RemediationDecision;
    if (!this.armed) {
      decision = { kind: 'none', reason: 'autopilot disarmed — decisions only, hands off the cluster' };
    } else {
      decision = evaluatePolicy(outcomes, this.store, this.thresholds);
      if (decision.kind === 'remediate') {
        await this.act(decision);
      } else if (decision.kind === 'escalate') {
        await this.escalate(decision);
      }
    }

    return {
      ts: new Date().toISOString(),
      cluster: { context, namespace: cfg.namespace },
      analyses: outcomes,
      automation: { armed: this.armed, decision },
    };
  }

  private async act(decision: RemediationDecision): Promise<void> {
    try {
      const deleted = await deletePods(this.cfg);
      this.push('action', decision.reason, {
        detail: `kubectl delete pod -l ${this.cfg.podSelector} -n ${this.cfg.namespace} → ${deleted} pod(s) deleted; the Deployment recreates them`,
        snapshot: decision.snapshot,
      });
    } catch (err) {
      // The policy already counted this attempt; if it stays broken the next
      // cycle escalates. Cluster errors land in the feed, never a crash.
      this.push('info', `remediation action failed: ${err instanceof Error ? err.message : String(err)}`, {
        snapshot: decision.snapshot,
      });
    }
  }

  private async escalate(decision: RemediationDecision): Promise<void> {
    const slack = await postSlack(this.cfg.slackWebhookUrl, `🚨 jev-ops autopilot: ${decision.reason}`);
    this.push('alert', decision.reason, { snapshot: decision.snapshot, slack });
  }
}
