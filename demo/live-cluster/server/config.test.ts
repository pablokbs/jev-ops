import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PACK_DIR, loadConfig } from './config.js';

test('defaults when no environment is set', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.jevopsBin, 'jev-ops');
  assert.equal(cfg.provider, 'typesafe');
  assert.equal(cfg.packDir, DEFAULT_PACK_DIR);
  assert.ok(cfg.packDir.endsWith('packs'));
  assert.equal(cfg.typesafeApiKey, null);
  assert.equal(cfg.kubeconfig, null);
  assert.equal(cfg.context, null);
  assert.equal(cfg.namespace, 'default');
  assert.equal(cfg.deployment, 'demo-app');
  assert.equal(cfg.podSelector, 'app=demo-app');
  assert.equal(cfg.demoAppPort, 3000);
  assert.equal(cfg.analyzeTail, 100);
  assert.equal(cfg.eventsWindowMinutes, 5);
});

test('environment overrides are honoured', () => {
  const cfg = loadConfig({
    PORT: '9090',
    JEVOPS_BIN: '/opt/bin/jev-ops',
    JEVOPS_PACK_DIR: '/tmp/packs',
    JEVOPS_PROVIDER: 'mock',
    TYPESAFE_API_KEY: 'ts_live_abc',
    K8S_KUBECONFIG: './cloud.kubeconfig',
    K8S_CONTEXT: 'prod-eu',
    K8S_NAMESPACE: 'demo',
    K8S_DEPLOYMENT: 'web',
    K8S_POD_SELECTOR: 'app=web',
    DEMO_APP_PORT: '4000',
    ANALYZE_TAIL: '250',
    K8S_EVENTS_WINDOW: '10',
  });
  assert.equal(cfg.port, 9090);
  assert.equal(cfg.jevopsBin, '/opt/bin/jev-ops');
  assert.equal(cfg.packDir, '/tmp/packs');
  assert.equal(cfg.provider, 'mock');
  assert.equal(cfg.typesafeApiKey, 'ts_live_abc');
  assert.equal(cfg.kubeconfig, './cloud.kubeconfig');
  assert.equal(cfg.context, 'prod-eu');
  assert.equal(cfg.namespace, 'demo');
  assert.equal(cfg.deployment, 'web');
  assert.equal(cfg.podSelector, 'app=web');
  assert.equal(cfg.demoAppPort, 4000);
  assert.equal(cfg.analyzeTail, 250);
  assert.equal(cfg.eventsWindowMinutes, 10);
});

test('blank API key is treated as missing', () => {
  assert.equal(loadConfig({ TYPESAFE_API_KEY: '   ' }).typesafeApiKey, null);
});