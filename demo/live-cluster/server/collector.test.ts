import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PodSummary } from './kubectl.js';
import { buildPodSummaryLines, formatEvents } from './collector.js';

function pod(partial: Partial<PodSummary> = {}): PodSummary {
  return {
    name: 'demo-app-abc',
    phase: 'Running',
    ready: true,
    restartCount: 0,
    crashLoop: false,
    oomKilled: false,
    terminating: false,
    ...partial,
  };
}

test('buildPodSummaryLines: healthy pod exposes "status: Running" for the mock provider', () => {
  const lines = buildPodSummaryLines([pod()]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /demo-app-abc status: Running restarts: 0/);
});

test('buildPodSummaryLines: crash loop and OOM markers', () => {
  const lines = buildPodSummaryLines([
    pod({ name: 'p1', phase: 'Running', crashLoop: true, restartCount: 8, ready: false }),
    pod({ name: 'p2', phase: 'Running', crashLoop: true, oomKilled: true, restartCount: 5, ready: false }),
  ]);
  assert.match(lines[0]!, /p1 status: Running CrashLoopBackOff restarts: 8/);
  assert.match(lines[1]!, /p2 status: Running CrashLoopBackOff restarts: 5 lastReason: OOMKilled/);
});

test('buildPodSummaryLines: terminating marker', () => {
  const lines = buildPodSummaryLines([pod({ name: 'old', terminating: true })]);
  assert.match(lines[0]!, /old status: Running restarts: 0 terminating/);
});

test('formatEvents: single formatting and aggregated counts', () => {
  const events = [
    {
      lastTimestamp: '2026-11-02T22:00:00Z',
      type: 'Warning',
      reason: 'BackOff',
      involvedObject: { name: 'demo-app-abc' },
      message: 'Back-off restarting failed container demo-app in pod demo-app-abc',
      count: 23,
    },
    {
      lastTimestamp: '2026-11-02T21:59:00Z',
      type: 'Warning',
      reason: 'OOMKilled',
      involvedObject: { name: 'demo-app-abc' },
      message: 'Container demo-app terminated with exit code 137',
      count: 1,
    },
  ];
  const lines = formatEvents(events);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^2026-11-02T22:00:00Z Warning BackOff demo-app-abc Back-off restarting failed container demo-app in pod demo-app-abc \(x23\)$/);
  assert.match(lines[1]!, /OOMKilled demo-app-abc Container demo-app terminated with exit code 137$/);
});

test('formatEvents: empty input yields empty lines', () => {
  assert.deepEqual(formatEvents([]), []);
});