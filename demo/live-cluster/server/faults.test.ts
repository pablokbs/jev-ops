import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PodSummary } from './kubectl.js';
import { FAULT_MODES, findExecPod } from './faults.js';

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

test('FAULT_MODES exposes the four demo modes', () => {
  assert.deepEqual([...FAULT_MODES], ['boom', 'crash', 'oom', 'reset']);
});

test('findExecPod prefers a ready running pod', () => {
  const pods = [
    pod({ name: 'pending', phase: 'Pending', ready: false }),
    pod({ name: 'starting', phase: 'Running', ready: false }),
    pod({ name: 'ready', phase: 'Running', ready: true }),
    pod({ name: 'old', phase: 'Running', ready: true, terminating: true }),
  ];
  const picked = findExecPod(pods);
  assert.equal(picked?.name, 'ready');
});

test('findExecPod falls back to any running pod', () => {
  const pods = [pod({ name: 'starting', phase: 'Running', ready: false })];
  assert.equal(findExecPod(pods)?.name, 'starting');
});

test('findExecPod returns null when nothing can exec', () => {
  const pods = [
    pod({ name: 'cl', phase: 'Running', crashLoop: true, ready: false }),
    pod({ name: 'pend', phase: 'Pending', ready: false }),
  ];
  assert.equal(findExecPod(pods), null);
});

test('findExecPod returns null on empty pod list', () => {
  assert.equal(findExecPod([]), null);
});