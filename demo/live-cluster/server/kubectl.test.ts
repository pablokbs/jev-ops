import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertOk, eventIsFresh, KubectlError, parsePod, podBreakdown, podState } from './kubectl.js';

function rawPod(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    metadata: { name: 'demo-app-abc', ...((overrides.metadata ?? {}) as object) },
    status: { phase: 'Running', containerStatuses: [], ...((overrides.status ?? {}) as object) },
    ...overrides,
  };
}

function containerStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'demo-app', ready: true, restartCount: 0, state: { running: {} }, ...overrides };
}

test('parsePod: healthy running pod', () => {
  const pod = parsePod(
    rawPod({ status: { phase: 'Running', containerStatuses: [containerStatus()] } }),
  );
  assert.equal(pod.name, 'demo-app-abc');
  assert.equal(pod.phase, 'Running');
  assert.equal(pod.ready, true);
  assert.equal(pod.restartCount, 0);
  assert.equal(pod.crashLoop, false);
  assert.equal(pod.oomKilled, false);
  assert.equal(pod.terminating, false);
});

test('parsePod: CrashLoopBackOff', () => {
  const pod = parsePod(
    rawPod({
      status: {
        phase: 'Running',
        containerStatuses: [
          containerStatus({
            ready: false,
            restartCount: 8,
            state: { waiting: { reason: 'CrashLoopBackOff', message: 'Back-off restarting failed container' } },
          }),
        ],
      },
    }),
  );
  assert.equal(pod.crashLoop, true);
  assert.equal(pod.ready, false);
  assert.equal(pod.restartCount, 8);
});

test('parsePod: OOMKilled as last state', () => {
  const pod = parsePod(
    rawPod({
      status: {
        phase: 'Running',
        containerStatuses: [
          containerStatus({
            ready: false,
            restartCount: 5,
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
          }),
        ],
      },
    }),
  );
  assert.equal(pod.crashLoop, true);
  assert.equal(pod.oomKilled, true);
});

test('parsePod: terminating pod', () => {
  const pod = parsePod(
    rawPod({
      metadata: { name: 'demo-app-old', deletionTimestamp: '2026-11-02T18:00:00Z' },
      status: { phase: 'Running', containerStatuses: [containerStatus()] },
    }),
  );
  assert.equal(pod.terminating, true);
});

test('podBreakdown groups pods by dashboard state', () => {
  const mk = (partial: Parameters<typeof parsePod>[0]): ReturnType<typeof parsePod> => parsePod(partial);
  const pods = [
    mk(rawPod({ status: { phase: 'Running', containerStatuses: [containerStatus()] } })),
    mk(rawPod({ status: { phase: 'Pending', containerStatuses: [] } })),
    mk(rawPod({ status: { phase: 'Running', containerStatuses: [containerStatus({ ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } })] } })),
    mk(rawPod({ metadata: { name: 'x', deletionTimestamp: '2026-11-02T18:00:00Z' } })),
  ];
  const b = podBreakdown(pods);
  assert.equal(b.total, 4);
  assert.equal(b.running, 1);
  assert.equal(b.starting, 1);
  assert.equal(b.crashLoop, 1);
  assert.equal(b.terminating, 1);
  assert.equal(b.oom, 0);
});

test('podState labels match the dashboard colour states', () => {
  const running = parsePod(rawPod({ status: { phase: 'Running', containerStatuses: [containerStatus()] } }));
  assert.equal(podState(running), 'running');
  const crash = parsePod(rawPod({ status: { phase: 'Running', containerStatuses: [containerStatus({ ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } })] } }));
  assert.equal(podState(crash), 'crashloop');
  const oom = parsePod(rawPod({ status: { phase: 'Running', containerStatuses: [containerStatus({ ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'OOMKilled' } } })] } }));
  assert.equal(podState(oom), 'oom');
});

test('eventIsFresh filters stale events by the window', () => {
  const now = Date.now();
  const fresh = {
    lastTimestamp: new Date(now - 60_000).toISOString(),
    type: 'Warning',
    reason: 'BackOff',
  };
  const stale = {
    lastTimestamp: new Date(now - 60 * 60_000).toISOString(),
    type: 'Warning',
    reason: 'BackOff',
  };
  const noTs = { type: 'Warning', reason: 'BackOff' };
  assert.equal(eventIsFresh(fresh, 15), true);
  assert.equal(eventIsFresh(stale, 15), false);
  assert.equal(eventIsFresh(noTs, 15), false);
});

test('assertOk throws KubectlError on non-zero exit', () => {
  assert.throws(() => assertOk({ code: 1, stdout: '', stderr: 'boom' }, 'test'), KubectlError);
});