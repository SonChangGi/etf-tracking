import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');

function dashboardHelpers() {
  const context = vm.createContext({ console });
  vm.runInContext(app, context, { filename: 'assets/app.js' });
  return context.__ETF_TRACKING_TESTS__;
}

test('result-first shell keeps signals and the primary chart ahead of detailed tables', () => {
  const results = html.indexOf('id="overview-metrics"');
  const signals = html.indexOf('id="signal-grid"');
  const chart = html.indexOf('id="weight-chart"');
  const top10 = html.indexOf('id="top10-rows"');
  const decomposition = html.indexOf('id="decomposition-detail"');
  const source = html.indexOf('id="source-detail"');
  assert.ok(results > 0);
  assert.ok(signals > results);
  assert.ok(chart > signals);
  assert.ok(top10 > chart);
  assert.ok(decomposition > top10);
  assert.ok(source > decomposition);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /id="chart-date"/);
  assert.match(html, /id="chart-selection-summary"/);
});

test('chart date navigation snaps only to stored observation dates', () => {
  const helpers = dashboardHelpers();
  const dates = ['2026-07-14', '2026-07-16', '2026-07-20'];
  assert.equal(helpers.nearestChartDate(dates, ''), '2026-07-20');
  assert.equal(helpers.nearestChartDate(dates, '2026-07-16'), '2026-07-16');
  assert.equal(helpers.nearestChartDate(dates, '2026-07-18'), '2026-07-16');
  assert.equal(helpers.nearestChartDate(dates, '2026-07-01'), '2026-07-14');
});

test('chart readout does not carry a holding value across a missing observation', () => {
  const helpers = dashboardHelpers();
  const points = [
    { date: '2026-07-14', value: 4.2 },
    { date: '2026-07-16', value: null },
  ];
  assert.deepEqual(
    { ...helpers.chartPointAtDate(points, '2026-07-14') },
    { date: '2026-07-14', value: 4.2 },
  );
  assert.deepEqual(
    { ...helpers.chartPointAtDate(points, '2026-07-16') },
    { date: '2026-07-16', value: null },
  );
  assert.equal(helpers.chartPointAtDate(points, '2026-07-15'), null);
});

test('theme storage uses the shared key while retaining ETF migration', () => {
  assert.match(app, /const THEME_STORAGE_KEY = 'quant-research-theme'/);
  assert.match(app, /'etf-tracking-theme'/);
});
