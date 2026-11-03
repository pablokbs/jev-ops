import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Typed environment configuration. All variables come from the environment. */
export interface Config {
  port: number;
  jevopsBin: string;
  packDir: string;
  provider: string;
  typesafeApiKey: string | null;
  kubeconfig: string | null;
  context: string | null;
  namespace: string;
  deployment: string;
  podSelector: string;
  demoAppPort: number;
  analyzeTail: number;
  eventsWindowMinutes: number;
  autopilotArmed: boolean;
  autopilotIntervalMs: number;
  autopilotMinConfidence: number;
  autopilotMinSeverity: number;
  autopilotMaxAttempts: number;
  slackWebhookUrl: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** Default pack directory: <repo>/demo/live-cluster/packs. */
export const DEFAULT_PACK_DIR = path.resolve(here, '..', 'packs');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number.parseInt(env.PORT ?? '8080', 10),
    jevopsBin: env.JEVOPS_BIN?.trim() || 'jev-ops',
    packDir: env.JEVOPS_PACK_DIR?.trim() || DEFAULT_PACK_DIR,
    // 'typesafe' on stage; switch to 'mock' for offline rehearsals and smoke tests.
    provider: env.JEVOPS_PROVIDER?.trim() || 'typesafe',
    typesafeApiKey: env.TYPESAFE_API_KEY?.trim() || null,
    kubeconfig: env.K8S_KUBECONFIG?.trim() || null,
    context: env.K8S_CONTEXT?.trim() || null,
    namespace: env.K8S_NAMESPACE?.trim() || 'default',
    deployment: env.K8S_DEPLOYMENT?.trim() || 'demo-app',
    podSelector: env.K8S_POD_SELECTOR?.trim() || 'app=demo-app',
    demoAppPort: Number.parseInt(env.DEMO_APP_PORT ?? '3000', 10),
    analyzeTail: Number.parseInt(env.ANALYZE_TAIL ?? '100', 10),
    // Warning events older than this are dropped from the diagnostic input.
    eventsWindowMinutes: Number.parseInt(env.K8S_EVENTS_WINDOW ?? '5', 10),
    // Autopilot: closed-loop remediation. Disarmed by default — arm it from
    // the dashboard (or here) once the talk reaches the automation part.
    autopilotArmed: (env.AUTOPILOT_ARMED ?? '').trim().toLowerCase() === 'true',
    autopilotIntervalMs: Number.parseInt(env.AUTOPILOT_INTERVAL_MS ?? '15000', 10),
    autopilotMinConfidence: Number.parseFloat(env.AUTOPILOT_MIN_CONFIDENCE ?? '0.85'),
    autopilotMinSeverity: Number.parseInt(env.AUTOPILOT_MIN_SEVERITY ?? '4', 10),
    autopilotMaxAttempts: Number.parseInt(env.AUTOPILOT_MAX_ATTEMPTS ?? '1', 10),
    // Optional Slack incoming webhook for escalation alerts (never required).
    slackWebhookUrl: env.SLACK_WEBHOOK_URL?.trim() || null,
  };
}