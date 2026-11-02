import type { Config } from './config.js';
import { getLogs, getPods, getPodsTable, getWarningEvents, type PodSummary } from './kubectl.js';

/** One diagnostic input ready to feed `jev-ops analyze`. */
export interface CollectedInput {
  pack: string;
  input: string;
  command: string;
}

const APP_PACK = 'demo-app';
const K8S_PACK = 'kubernetes';

/**
 * Compact per-pod status lines. The `status: <Phase>` phrasing gives the
 * live model a stable state signal and the offline mock provider the exact
 * "status: Running" marker it keys on during smoke tests.
 */
export function buildPodSummaryLines(pods: PodSummary[]): string[] {
  return pods.map((p) => {
    const bits = [`${p.name} status: ${p.phase}`];
    if (p.crashLoop) bits.push('CrashLoopBackOff');
    bits.push(`restarts: ${p.restartCount}`);
    if (p.oomKilled) bits.push('lastReason: OOMKilled');
    if (p.terminating) bits.push('terminating');
    return bits.join(' ');
  });
}

/** Warning events formatted as one human-readable line each (newest first). */
export function formatEvents(events: Array<Record<string, unknown>>): string[] {
  return events.map((e) => {
    const ts = String(e.lastTimestamp ?? e.eventTime ?? '');
    const reason = String(e.reason ?? '');
    const object = String((e.involvedObject as Record<string, unknown> | undefined)?.name ?? '');
    const message = String(e.message ?? '').trim();
    const count = Number(e.count ?? 0);
    const line = [ts, 'Warning', reason, object, message].filter(Boolean).join(' ');
    return count > 1 ? `${line} (x${count})` : line;
  });
}

/** Application logs + pod status summary → demo-app pack input. */
export async function collectAppInput(cfg: Config): Promise<CollectedInput> {
  const [logs, pods] = await Promise.all([getLogs(cfg, cfg.analyzeTail), getPods(cfg)]);
  const summary = buildPodSummaryLines(pods);
  const input = [
    logs.trim(),
    '--- pod status ---',
    summary.length > 0 ? summary.join('\n') : 'no pods found',
  ].join('\n');
  return {
    pack: APP_PACK,
    input,
    command: `kubectl logs -l ${cfg.podSelector} -n ${cfg.namespace} --tail=${cfg.analyzeTail} --all-containers | jev-ops analyze ${APP_PACK} --json`,
  };
}

/** Pod table + warning events + status summary → kubernetes pack input. */
export async function collectK8sInput(cfg: Config): Promise<CollectedInput> {
  const [table, events, pods] = await Promise.all([
    getPodsTable(cfg),
    getWarningEvents(cfg, 40, cfg.eventsWindowMinutes),
    getPods(cfg),
  ]);
  const summary = buildPodSummaryLines(pods);
  const input = [
    table || '(no pods)',
    '--- warning events ---',
    formatEvents(events).join('\n') || '(no warning events)',
    '--- status summary ---',
    summary.length > 0 ? summary.join('\n') : '(no pods)',
  ].join('\n');
  return {
    pack: K8S_PACK,
    input,
    command: `kubectl get pods -l ${cfg.podSelector} -n ${cfg.namespace} && kubectl get events -n ${cfg.namespace} | jev-ops analyze ${K8S_PACK} --json`,
  };
}