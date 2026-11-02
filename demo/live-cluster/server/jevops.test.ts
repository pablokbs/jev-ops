import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, parseAnalysisOutput } from './jevops.js';

const COMMAND = 'kubectl logs … | jev-ops analyze demo-app --json';

const OK_BODY = {
  schema_version: '1',
  pack: { name: 'demo-app', version: '0.1.0' },
  provider: 'typesafe-jev (jev-latest)',
  input: { bytes: 512, truncated: false },
  decisions: {
    health: { type: 'choice', value: 'healthy', confidence: 0.98 },
    needs_attention: { type: 'boolean', value: false, confidence: 0.99 },
  },
};

function fakeBin(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevops-test-'));
  const bin = path.join(dir, 'fake-jev-ops');
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  return bin;
}

test('parseAnalysisOutput: valid body', () => {
  const parsed = parseAnalysisOutput(JSON.stringify(OK_BODY));
  assert.equal(parsed.provider, 'typesafe-jev (jev-latest)');
  assert.equal(parsed.input.bytes, 512);
  const health = parsed.decisions.health;
  assert.ok(health);
  assert.equal(health.value, 'healthy');
});

test('parseAnalysisOutput: rejects malformed bodies', () => {
  assert.throws(() => parseAnalysisOutput('not json'));
  assert.throws(() => parseAnalysisOutput(JSON.stringify({ schema_version: '1' })));
  assert.throws(() => parseAnalysisOutput(JSON.stringify({ ...OK_BODY, schema_version: '9' })));
});

test('analyze: missing API key fails fast without spawning', async () => {
  const outcome = await analyze({
    bin: '/nonexistent/jev-ops',
    packDir: '/tmp/packs',
    apiKey: null,
    pack: 'demo-app',
    input: 'logs',
    command: COMMAND,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /TYPESAFE_API_KEY/);
});

test('analyze: mock provider does not require an API key', async () => {
  const bin = fakeBin(`process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify({ ...OK_BODY, provider: 'mock' }))}));`);
  const outcome = await analyze({
    bin,
    packDir: '/tmp/packs',
    apiKey: null,
    provider: 'mock',
    pack: 'demo-app',
    input: 'logs',
    command: COMMAND,
  });
  assert.equal(outcome.ok, true);
});

test('analyze: binary not found maps to clear error', async () => {
  const outcome = await analyze({
    bin: '/nonexistent/jev-ops',
    packDir: '/tmp/packs',
    apiKey: 'ts_live_x',
    pack: 'demo-app',
    input: 'logs',
    command: COMMAND,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /not found/);
});

test('analyze: successful run parses decisions and timing', async () => {
  const bin = fakeBin(`process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(OK_BODY))}));`);
  const outcome = await analyze({
    bin,
    packDir: '/tmp/packs',
    apiKey: 'ts_live_x',
    pack: 'demo-app',
    input: 'some logs\n',
    command: COMMAND,
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.pack, 'demo-app');
    assert.match(outcome.provider, /typesafe-jev/);
    assert.equal(outcome.inputBytes, 512);
    const health = outcome.decisions.health;
    assert.ok(health);
    assert.equal(health.value, 'healthy');
    assert.ok(outcome.elapsedMs >= 0);
  }
});

test('analyze: exit code 5 (provider failure) surfaces a readable message', async () => {
  const bin = fakeBin(`process.stderr.write('no api key or api error\\n'); process.exit(5);`);
  const outcome = await analyze({
    bin,
    packDir: '/tmp/packs',
    apiKey: 'ts_live_x',
    pack: 'demo-app',
    input: 'logs',
    command: COMMAND,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /code 5|provider failed/);
});

test('analyze: exit code 3 (invalid pack) surfaces a readable message', async () => {
  const bin = fakeBin(`process.stderr.write('pack not found\\n'); process.exit(3);`);
  const outcome = await analyze({
    bin,
    packDir: '/tmp/packs',
    apiKey: 'ts_live_x',
    pack: 'nope',
    input: 'logs',
    command: COMMAND,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /invalid pack/);
});