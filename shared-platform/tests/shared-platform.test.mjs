import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const repositoryRoot = new URL('../../', import.meta.url);

function createRuntime() {
  const context = vm.createContext({
    AbortController,
    URL,
    clearTimeout,
    console,
    setTimeout,
  });
  vm.runInContext(source, context, { filename: 'shared-platform/src/index.js' });
  return context.__ETF_SHARED_PLATFORM__;
}

async function json(path) {
  return JSON.parse(await readFile(new URL(path, repositoryRoot), 'utf8'));
}

async function rawSnapshot() {
  return {
    dashboard: await json('data/dashboard.json'),
    status: await json('data/status.json'),
    historyManifest: await json('data/history.json'),
    automation: await json('data/automation-status.json'),
  };
}

test('control registry exposes no analysis run and isolates owner operations', () => {
  const api = createRuntime();
  api.assertControlManifest();
  const kinds = new Set(
    api.etfControlManifest.controls.map((control) => control.controlKind),
  );
  assert.deepEqual([...kinds].sort(), ['display', 'operation', 'result_selector']);
  assert.equal(
    api.etfControlManifest.controls.filter(
      (control) => control.controlKind === 'analysis',
    ).length,
    0,
  );
  assert.deepEqual(
    Array.from(
      api.etfControlManifest.controls
      .filter((control) => control.controlKind === 'operation')
      .map((control) => ({
        id: control.id,
        operationKey: control.operationKey,
        requiresAuthentication: control.requiresAuthentication,
      })),
    ),
    [
      {
        id: 'owner_refresh_backfill',
        operationKey: 'github-actions:update-data.yml',
        requiresAuthentication: true,
      },
    ],
  );
});

test('canonical navigation keeps all nine projects and ETF as current', () => {
  const api = createRuntime();
  assert.equal(api.canonicalProjectRegistry.length, 9);
  assert.deepEqual(
    Array.from(api.canonicalProjectRegistry, (project) => project.id),
    [
      'hub',
      'fear-greed',
      'momentum',
      'dram',
      'best-factor',
      'etf',
      'sox',
      'port',
      'kelly',
    ],
  );
  const current = Array.from(api.getCanonicalNavigation('etf')).filter(
    (project) => project.current,
  );
  assert.equal(current.length, 1);
  assert.equal(current[0].url, 'https://sonchanggi.github.io/etf-tracking/');
});

test('static adapter preserves existing payload objects and records one identity', async () => {
  const api = createRuntime();
  const payloads = await rawSnapshot();
  const adapted = api.adaptEtfStaticResultV1(payloads);
  assert.equal(adapted.data.dashboard, payloads.dashboard);
  assert.equal(adapted.data.status, payloads.status);
  assert.equal(adapted.data.historyManifest, payloads.historyManifest);
  assert.equal(adapted.data.automation, payloads.automation);
  assert.equal(adapted.identity.projectId, 'etf');
  assert.equal(adapted.identity.contractVersion, 'etf-static-result/v1');
  assert.equal(adapted.identity.sharedVersion, 'quant-platform-frontend/0.1.0');
  assert.equal(adapted.identity.dataAsOf, payloads.historyManifest.availableEndDate);
  assert.equal(Object.keys(adapted.identity.expectedHistories).length, 3);
});

test('static adapter fails closed for mixed snapshot files and embedded history', async () => {
  const api = createRuntime();
  const mixed = await rawSnapshot();
  mixed.status.generatedAt = '2026-07-24T04:34:40+00:00';
  assert.throws(
    () => api.adaptEtfStaticResultV1(mixed),
    /generatedAt이 파일 사이에서 일치하지 않습니다/,
  );

  const embedded = await rawSnapshot();
  embedded.dashboard.etfs[0].history = [{ date: '2026-07-24' }];
  assert.throws(
    () => api.adaptEtfStaticResultV1(embedded),
    /대용량 history가 포함되었습니다/,
  );
});

test('static adapter preserves a published degraded status without pretending it is fresh', async () => {
  const api = createRuntime();
  const payloads = await rawSnapshot();
  const dataAsOf = payloads.historyManifest.availableEndDate;
  const targetDate = payloads.status.targetDate;
  payloads.status.overallStatus = 'degraded';
  payloads.automation.targetDate = targetDate;
  payloads.automation.runStatus = 'waiting_for_data';
  const adapted = api.adaptEtfStaticResultV1(payloads);
  assert.equal(adapted.identity.dataAsOf, dataAsOf);
  assert.equal(adapted.data.status.overallStatus, 'degraded');
  assert.equal(adapted.data.automation.runStatus, 'waiting_for_data');
});

test('history adapter binds a per-ETF file to the verified snapshot', async () => {
  const api = createRuntime();
  const adapted = api.adaptEtfStaticResultV1(await rawSnapshot());
  const etfId = 'koact-nasdaq-growth-active';
  const payload = await json(`data/history/${etfId}.json`);
  const history = api.adaptEtfHistoryV1(payload, adapted.identity, etfId);
  assert.equal(history.data, payload);
  assert.equal(history.identity.historyCount, payload.history.length);

  const wrongCount = structuredClone(payload);
  wrongCount.historyCount += 1;
  assert.throws(
    () => api.adaptEtfHistoryV1(wrongCount, adapted.identity, etfId),
    /identity\/count가 다릅니다/,
  );

  const wrongSnapshot = structuredClone(payload);
  wrongSnapshot.generatedAt = '2026-07-24T04:34:40+00:00';
  assert.throws(
    () => api.adaptEtfHistoryV1(wrongSnapshot, adapted.identity, etfId),
    /선택 snapshot과 일치하지 않습니다/,
  );
});

test('loader performs only same-origin no-store GET requests and has no fallback', async () => {
  const api = createRuntime();
  const payloads = await rawSnapshot();
  const byPath = new Map([
    ['/etf-tracking/data/dashboard.json', payloads.dashboard],
    ['/etf-tracking/data/status.json', payloads.status],
    ['/etf-tracking/data/history.json', payloads.historyManifest],
    ['/etf-tracking/data/automation-status.json', payloads.automation],
  ]);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = byPath.get(new URL(url).pathname);
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: async () => body,
    };
  };
  const loaded = await api.loadEtfStaticSnapshotV1({
    baseUrl: 'https://sonchanggi.github.io/etf-tracking/',
    fetchImpl,
    timeoutMs: 500,
  });
  assert.equal(loaded.identity.dataAsOf, payloads.historyManifest.availableEndDate);
  assert.equal(calls.length, 4);
  assert.ok(
    calls.every(
      ({ url, init }) =>
        new URL(url).origin === 'https://sonchanggi.github.io' &&
        init.method === 'GET' &&
        init.cache === 'no-store' &&
        init.headers.Accept === 'application/json',
    ),
  );

  await assert.rejects(
    api.loadEtfStaticSnapshotV1({
      baseUrl: 'https://sonchanggi.github.io/etf-tracking/',
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      timeoutMs: 500,
    }),
    /HTTP 503/,
  );
  assert.throws(
    () =>
      api.resolveSameOrigin(
        'https://example.com/data/dashboard.json',
        'https://sonchanggi.github.io/etf-tracking/',
      ),
    /same-origin/,
  );
});

test('browser seam contains contracts only, not ETF result payloads or run transport', async () => {
  const output = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  const size = (await stat(new URL('../dist/index.js', import.meta.url))).size;
  assert.equal(output, source);
  assert.ok(size < 100_000, `compatibility seam unexpectedly large: ${size}`);
  assert.doesNotMatch(output, /Space Exploration Technologies/);
  assert.doesNotMatch(output, /\/v1\/projects\/[^/]+\/runs|\/v1\/runs\//);
  assert.doesNotMatch(output, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
});
