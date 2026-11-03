import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { Autopilot, postSlack, serialized } from './autopilot.js';
import { loadConfig } from './config.js';

const cfg = (env: NodeJS.ProcessEnv = {}) => loadConfig({ ...env });

test('serialized() shares one in-flight run across concurrent callers', async () => {
  let runs = 0;
  const once = serialized(async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return runs;
  });
  const [a, b, c] = await Promise.all([once(), once(), once()]);
  assert.equal(runs, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(c, 1);
  // After it settles, the next call runs again.
  assert.equal(await once(), 2);
});

test('postSlack without a webhook URL is a no-op', async () => {
  assert.equal(await postSlack(null, 'hello'), 'not-configured');
});

test('postSlack posts the text payload and reports the outcome', async () => {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push(body);
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const result = await postSlack(`http://127.0.0.1:${address.port}/hook`, 'escalate me');
    assert.equal(result, 'sent');
    assert.deepEqual(JSON.parse(received[0] ?? ''), { text: 'escalate me' });
  } finally {
    server.close();
  }
});

test('postSlack failing webhook → failed (never throws)', async () => {
  // Nothing listens on this port — connection refused.
  assert.equal(await postSlack('http://127.0.0.1:1/hook', 'x'), 'failed');
});

test('autopilot starts disarmed by default and toggles emit feed events', () => {
  const ap = new Autopilot(cfg());
  assert.equal(ap.isArmed(), false);
  assert.equal(ap.getState().feed.length, 0);

  ap.setArmed(true);
  assert.equal(ap.isArmed(), true);
  ap.setArmed(false);
  assert.equal(ap.isArmed(), false);

  const feed = ap.getState().feed;
  assert.equal(feed.length, 2);
  assert.match(feed[0]?.text ?? '', /DISARMED/);
  assert.match(feed[1]?.text ?? '', /ARMED/);
  // Policy view mirrors the config.
  assert.equal(ap.getState().policy.minSeverity, 4);
  assert.equal(ap.getState().policy.minConfidence, 0.85);
  assert.equal(ap.getState().policy.maxAttempts, 1);
});

test('autopilot honours AUTOPILOT_* config and caps the feed at 50', () => {
  const ap = new Autopilot(cfg({ AUTOPILOT_MIN_CONFIDENCE: '0.5', AUTOPILOT_MIN_SEVERITY: '3' }));
  assert.equal(ap.getState().policy.minConfidence, 0.5);
  assert.equal(ap.getState().policy.minSeverity, 3);
  for (let i = 0; i < 30; i++) {
    ap.setArmed(true);
    ap.setArmed(false);
  }
  assert.equal(ap.getState().feed.length, 50);
});

test('AUTOPILOT_ARMED=true boots the loop armed', () => {
  const ap = new Autopilot(cfg({ AUTOPILOT_ARMED: 'true' }));
  assert.equal(ap.isArmed(), true);
  assert.match(ap.getState().feed[0]?.text ?? '', /started ARMED/);
  ap.setArmed(false); // stop the loop so the test exits cleanly
});
