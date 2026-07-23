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
  assert.doesNotMatch(html, /Python이 생성한 편입·편출 및 잔차 신호를 그대로 표시합니다/);
  assert.doesNotMatch(html, /표시 설정은 저장된 분석 결과를 다시 계산하지 않습니다/);
});

test('chart values stay in the normal-flow summary instead of covering the plot', () => {
  assert.match(html, /id="chart-selection-summary"/);
  assert.doesNotMatch(app, /chart-active-readout/);
  assert.doesNotMatch(app, /<title id="weight-chart-svg-title"/);
  assert.doesNotMatch(app, /renderSeriesValueLabels/);
  assert.match(app, /aria-labelledby="chart-title weight-chart-svg-desc"/);
  assert.match(app, /const padding = Math\.max\(56, margin\.right\)/);
});

test('end labels reserve non-overlapping vertical slots', () => {
  const helpers = dashboardHelpers();
  const series = Array.from({ length: 10 }, (_, index) => ({
    key: `S${index}`,
    rank: index + 1,
    fullLabel: `Series ${index + 1}`,
    tickerLabel: `S${index}`,
    validPoints: [{ date: '2026-07-23', value: 5 + index * 0.001 }],
  }));
  const labels = helpers.buildEndLabels(series, () => 800, () => 150, 48, 392);
  assert.equal(labels.length, 10);
  labels.forEach((label) => {
    assert.ok(label.y2 >= 61);
    assert.ok(label.y2 <= 379);
  });
  labels.slice(1).forEach((label, index) => {
    assert.ok(label.y2 - labels[index].y2 >= 24);
  });
});

test('verbose per-row explanations are not rendered into visible cards or tables', () => {
  assert.doesNotMatch(app, /className = 'action-explanation'/);
  assert.doesNotMatch(app, /signal\.actionExplanation \|\| signal\.message/);
  assert.doesNotMatch(app, /interpretationCell\(/);
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
