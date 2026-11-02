import { spawn } from 'node:child_process';
import type { Config } from './config.js';

/** Result of a kubectl invocation. */
export interface CmdResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A single pod summarised the way the dashboard and collectors need it. */
export interface PodSummary {
  name: string;
  phase: string; // Running | Pending | Succeeded | Failed | Unknown
  ready: boolean;
  restartCount: number;
  crashLoop: boolean; // container waiting with reason CrashLoopBackOff
  oomKilled: boolean; // last state terminated with reason OOMKilled
  terminating: boolean; // deletionTimestamp set (pod being deleted)
}

export class KubectlError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stderr = '') {
    super(message);
    this.name = 'KubectlError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const KUBECTL = 'kubectl';

/** Promisified kubectl spawn. No shell: args are passed verbatim. */
export function runKubectl(
  cfg: Config,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CmdResult> {
  const { timeoutMs = 15_000 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(KUBECTL, args, {
      env: { ...process.env, ...(cfg.kubeconfig ? { KUBECONFIG: cfg.kubeconfig } : {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new KubectlError(`kubectl timed out after ${timeoutMs}ms: kubectl ${args.join(' ')}`, null, stderr));
    }, timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new KubectlError('kubectl binary not found on PATH; install kubectl and point it at a cluster', null));
      } else {
        reject(new KubectlError(`kubectl failed to start: ${err.message}`, null, stderr));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function assertOk(result: CmdResult, what: string): string {
  if (result.code !== 0) {
    throw new KubectlError(`kubectl ${what} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`, result.code, result.stderr);
  }
  return result.stdout;
}

export async function getContext(cfg: Config): Promise<string | null> {
  const result = await runKubectl(cfg, ['config', 'current-context']);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export async function getDeployment(cfg: Config): Promise<{
  name: string;
  replicas: number;
  readyReplicas: number;
  unavailableReplicas: number;
}> {
  const stdout = assertOk(
    await runKubectl(cfg, ['get', 'deployment', cfg.deployment, '-n', cfg.namespace, '-o', 'json']),
    'get deployment',
  );
  const doc = JSON.parse(stdout);
  const status = doc.status ?? {};
  return {
    name: doc.metadata?.name ?? cfg.deployment,
    replicas: status.replicas ?? 0,
    readyReplicas: status.readyReplicas ?? 0,
    unavailableReplicas: status.unavailableReplicas ?? 0,
  };
}

/** Parses one `kubectl get pods -o json` item into a PodSummary. */
export function parsePod(item: unknown): PodSummary {
  const doc = (item ?? {}) as Record<string, unknown>;
  const meta = (doc.metadata ?? {}) as Record<string, unknown>;
  const status = (doc.status ?? {}) as Record<string, unknown>;
  const containerStatuses = (status.containerStatuses ?? []) as Array<Record<string, unknown>>;
  const cs = containerStatuses[0] ?? {};
  const state = (cs.state ?? {}) as Record<string, unknown>;
  const waiting = (state.waiting ?? {}) as Record<string, unknown>;
  const lastTerminated = ((state.terminated ?? cs.lastState ?? {}) as Record<string, unknown>).terminated as
    | Record<string, unknown>
    | undefined;
  const deleted = (meta.deletionTimestamp ?? null) !== null;

  return {
    name: String(meta.name ?? 'unknown'),
    phase: String(status.phase ?? 'Unknown'),
    // Trust the container status when present; fall back to phase only for pods
    // with no containers yet (e.g. Pending) so they render as "starting".
    ready: cs.ready === undefined ? status.phase === 'Running' : Boolean(cs.ready),
    restartCount: Number(((cs.restartCount ?? 0) as number) || 0),
    crashLoop: waiting.reason === 'CrashLoopBackOff',
    oomKilled: (lastTerminated?.reason ?? '') === 'OOMKilled',
    terminating: deleted,
  };
}

export async function getPods(cfg: Config): Promise<PodSummary[]> {
  const stdout = assertOk(
    await runKubectl(cfg, ['get', 'pods', '-l', cfg.podSelector, '-n', cfg.namespace, '-o', 'json']),
    'get pods',
  );
  const doc = JSON.parse(stdout) as { items?: unknown[] };
  return (doc.items ?? []).map(parsePod);
}

/** Raw `kubectl get pods -l …` column output — the classic table the kubernetes pack knows. */
export async function getPodsTable(cfg: Config): Promise<string> {
  return assertOk(
    await runKubectl(cfg, ['get', 'pods', '-l', cfg.podSelector, '-n', cfg.namespace]),
    'get pods table',
  ).trim();
}

/** Pod log lines for the pod selector; tolerant of pods that are still starting. */
export async function getLogs(cfg: Config, tail: number): Promise<string> {
  const result = await runKubectl(cfg, [
    'logs',
    '-l',
    cfg.podSelector,
    '-n',
    cfg.namespace,
    '--tail',
    String(tail),
    '--all-containers',
    '--prefix=true',
  ]);
  if (result.code === 0) return result.stdout;
  const stderr = result.stderr.trim();
  // Benign conditions: nothing deployed yet, or containers still waiting to start.
  if (/no resources found|waiting to start|is not ready|the server is currently unable/.test(stderr)) {
    return '';
  }
  throw new KubectlError(`kubectl logs failed (exit ${result.code}): ${stderr || result.stdout.trim()}`, result.code, result.stderr);
}

/**
 * Warning events in the namespace as raw JSON objects (newest first, capped).
 * `sinceMinutes` drops stale events so earlier faults don't contaminate later
 * analyses (events persist in the namespace for ~1h).
 */
export async function getWarningEvents(
  cfg: Config,
  limit = 40,
  sinceMinutes = 5,
): Promise<Array<Record<string, unknown>>> {
  const stdout = assertOk(
    await runKubectl(cfg, ['get', 'events', '-n', cfg.namespace, '-o', 'json']),
    'get events',
  );
  const doc = JSON.parse(stdout) as { items?: Array<Record<string, unknown>> };
  const events = (doc.items ?? []).filter((e) => {
    const type = String((e as { type?: unknown }).type ?? '');
    const reason = String((e as { reason?: unknown }).reason ?? '');
    return (
      (type === 'Warning' || reason === 'BackOff' || reason === 'OOMKilled') &&
      eventIsFresh(e, sinceMinutes)
    );
  });
  events.sort((a, b) => String(b.lastTimestamp).localeCompare(String(a.lastTimestamp)));
  return events.slice(0, limit);
}

/** True when the event happened within `sinceMinutes` of now. */
export function eventIsFresh(event: Record<string, unknown>, sinceMinutes: number): boolean {
  const rawTs =
    String(event.lastTimestamp ?? '') ||
    String(event.eventTime ?? '') ||
    String(((event.metadata as Record<string, unknown> | undefined)?.creationTimestamp ?? ''));
  if (!rawTs) return false;
  const ts = Date.parse(rawTs);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= sinceMinutes * 60_000;
}

/** Runs a command inside a pod via `kubectl exec … -- sh -c '<cmd>'`. */
export async function exec(
  cfg: Config,
  podName: string,
  cmd: string,
  timeoutMs = 10_000,
): Promise<CmdResult> {
  return runKubectl(
    cfg,
    ['exec', '-n', cfg.namespace, podName, '--', 'sh', '-c', cmd],
    { timeoutMs },
  );
}

/** Deletes every pod matching the selector (used to recover from crash/OOM loops). */
export async function deletePods(cfg: Config): Promise<number> {
  const stdout = assertOk(
    await runKubectl(cfg, ['delete', 'pod', '-l', cfg.podSelector, '-n', cfg.namespace, '--wait=false']),
    'delete pods',
  );
  const deleted = (stdout.match(/deleted/g) ?? []).length;
  return deleted > 0 ? deleted : 1; // kubectl prints one "deleted" line per pod
}

/** Groups pods into the dashboard's visual states. */
export function podBreakdown(pods: PodSummary[]): {
  running: number;
  starting: number;
  crashLoop: number;
  oom: number;
  terminating: number;
  total: number;
} {
  const breakdown = { running: 0, starting: 0, crashLoop: 0, oom: 0, terminating: 0, total: pods.length };
  for (const pod of pods) {
    if (pod.terminating) breakdown.terminating += 1;
    else if (pod.oomKilled) breakdown.oom += 1;
    else if (pod.crashLoop) breakdown.crashLoop += 1;
    else if (pod.phase === 'Running' && pod.ready) breakdown.running += 1;
    else breakdown.starting += 1; // Pending or Running-but-not-ready
  }
  return breakdown;
}

/** Per-pod dashboard state label. */
export function podState(pod: PodSummary): 'running' | 'starting' | 'crashloop' | 'oom' | 'terminating' {
  if (pod.terminating) return 'terminating';
  // An OOM-killed pod is also CrashLoopBackOff — the OOM signal is the more specific one.
  if (pod.oomKilled) return 'oom';
  if (pod.crashLoop) return 'crashloop';
  if (pod.phase === 'Running' && pod.ready) return 'running';
  return 'starting';
}