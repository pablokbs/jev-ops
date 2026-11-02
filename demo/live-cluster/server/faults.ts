import type { Config } from './config.js';
import { deletePods, exec, getPods, type PodSummary } from './kubectl.js';

export type FaultMode = 'boom' | 'crash' | 'oom' | 'reset';

export interface FaultResult {
  mode: FaultMode;
  detail: string;
  podUsed?: string;
}

export const FAULT_MODES: readonly FaultMode[] = ['boom', 'crash', 'oom', 'reset'];

/** Pick a pod we can exec into: a ready Running pod, else any Running pod. */
export function findExecPod(pods: PodSummary[]): PodSummary | null {
  const running = pods.filter(
    (p) => p.phase === 'Running' && !p.terminating && !p.crashLoop && !p.oomKilled,
  );
  return running.find((p) => p.ready) ?? running[0] ?? null;
}

function wgetCmd(cfg: Config, path: string): string {
  return `wget -qO- http://localhost:${cfg.demoAppPort}/${path}`;
}

function bashEscape(value: string): string {
  return value.replace(/[\\'"]/g, (c) => `\\${c}`);
}

/**
 * Injects (or clears) a fault in the demo app:
 * - boom / crash / oom: curl-ish the app endpoint inside a running pod.
 * - reset: clears the flag in a running pod; if no pod is running (crash-loop
 *   or OOM backoff), deletes the pods so they come back fresh.
 */
export async function triggerFault(cfg: Config, mode: FaultMode): Promise<FaultResult> {
  const pods = await getPods(cfg);
  const pod = findExecPod(pods);

  if (mode === 'reset') {
    // Fast path: clear the flag in every running pod.
    let cleared: string[] = [];
    for (const p of pods) {
      if (p.phase === 'Running' && !p.terminating && !p.crashLoop && !p.oomKilled) {
        const res = await exec(cfg, p.name, wgetCmd(cfg, 'reset'));
        if (res.code === 0) cleared.push(p.name);
      }
    }
    // Crash/OOM-looped pods keep their persisted flag in their own emptyDir —
    // exec cannot reach them, so delete them and let the Deployment recreate.
    const stuck = pods.filter((p) => p.crashLoop || p.oomKilled || p.terminating);
    if (stuck.length > 0) {
      const deleted = await deletePods(cfg);
      return {
        mode,
        podUsed: cleared[0],
        detail: `cleared ${cleared.length} running pod(s); deleted ${deleted} stuck pod(s) (crash/OOM loop)`,
      };
    }
    if (cleared.length === 0) {
      return { mode, detail: 'nothing to clear — no running or stuck pods' };
    }
    return { mode, podUsed: cleared[0], detail: `cleared fault flag in ${cleared.join(', ')}` };
  }

  if (!pod) {
    // With the flag persisted the pod keeps failing on its own; nothing to exec.
    if (mode === 'crash' || mode === 'oom') {
      return { mode, detail: 'no running pod right now — persisted fault flag already in effect' };
    }
    throw new Error('no running pod to inject the fault into (is the app deployed?)');
  }

  const res = await exec(cfg, pod.name, wgetCmd(cfg, bashEscape(mode)));
  if (res.code !== 0) {
    throw new Error(`fault injection failed in ${pod.name}: ${res.stderr.trim()}`);
  }
  return { mode, podUsed: pod.name, detail: `triggered /${mode} in ${pod.name}` };
}