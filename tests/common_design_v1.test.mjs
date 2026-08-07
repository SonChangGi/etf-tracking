import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../assets/styles.css', import.meta.url), 'utf8');

function dashboardHelpers() {
  const context = vm.createContext({ console });
  vm.runInContext(app, context, { filename: 'assets/app.js' });
  return context.__ETF_TRACKING_TESTS__;
}

test('result-first shell keeps signals and the primary chart ahead of detailed tables', () => {
  const results = html.indexOf('id="overview-metrics"');
  const signals = html.indexOf('id="signal-grid"');
  const chart = html.indexOf('id="weight-chart"');
  const periodControls = html.indexOf('id="start-date"');
  const top10 = html.indexOf('id="top10-rows"');
  const decomposition = html.indexOf('id="decomposition-detail"');
  const operations = html.indexOf('id="operations-detail"');
  const source = html.indexOf('id="source-detail"');
  assert.ok(results > 0);
  assert.ok(signals > results);
  assert.ok(chart > signals);
  assert.ok(periodControls > chart);
  assert.ok(top10 > periodControls);
  assert.ok(decomposition > top10);
  assert.ok(operations > decomposition);
  assert.ok(source > operations);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /id="chart-date"/);
  assert.match(html, /id="chart-selection-summary"/);
  assert.doesNotMatch(html, /Python이 생성한 편입·편출 및 잔차 신호를 그대로 표시합니다/);
  assert.doesNotMatch(html, /표시 설정은 저장된 분석 결과를 다시 계산하지 않습니다/);
});

test('common design v1.2 keeps the compact type hierarchy and eleven-project navigation', () => {
  assert.match(styles, /body\s*\{[^}]*font-size:\s*15px;[^}]*line-height:\s*1\.55;/s);
  assert.match(styles, /h1\s*\{[^}]*font-size:\s*clamp\(2rem,\s*4vw,\s*3\.25rem\)/s);
  assert.match(styles, /h2\s*\{[^}]*font-size:\s*clamp\(1\.35rem,\s*2\.3vw,\s*1\.8rem\)/s);
  assert.doesNotMatch(styles, /font-weight:\s*(?:8\d\d|9\d\d)/);

  const nav = html.match(/<div class="site-nav-links"[\s\S]*?<\/div>/)?.[0] || '';
  const links = [...nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(links.length, 10);
  assert.deepEqual(
    links.map((match) => match[2].replace(/&amp;/g, '&').trim()),
    ['Hub', 'Fear & Greed', 'Momentum', 'DRAM', 'Best Factor', 'ETF', 'SOX', 'Risk Score', 'Port', 'Valuation'],
  );
  assert.equal(links.filter((match) => /aria-current="page"/.test(match[0])).length, 1);
  assert.match(links[5][0], /aria-current="page"/);
});

test('implementation notes live in one closed operations disclosure', () => {
  assert.match(html, /<details[^>]*id="operations-detail"[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b[^>]*id="operations-detail"/);
  const operationsStart = html.indexOf('id="operations-detail"');
  const operationsEnd = html.indexOf('</details>', operationsStart);
  for (const id of ['source-detail', 'methodology', 'manual-update']) {
    const index = html.indexOf(`id="${id}"`);
    assert.ok(index > operationsStart && index < operationsEnd);
  }
  assert.doesNotMatch(html, /Common Design v1/);
  assert.doesNotMatch(html, /기존 Python 분류값/);
  assert.doesNotMatch(html, /필요할 때만 상세 히스토리를 불러옵니다/);
});

test('chart values stay in the normal-flow summary instead of covering the plot', () => {
  assert.match(html, /id="chart-selection-summary"/);
  assert.doesNotMatch(app, /chart-active-readout/);
  assert.doesNotMatch(app, /<title id="weight-chart-svg-title"/);
  assert.doesNotMatch(app, /renderSeriesValueLabels/);
  assert.match(app, /aria-labelledby="chart-title weight-chart-svg-desc"/);
  assert.match(app, /const padding = Math\.max\(56, margin\.right\)/);
  assert.doesNotMatch(app, /class="chart-series[^"]*"[^>]*tabindex="0"/);
  assert.doesNotMatch(app, /기본 보기 최근 1개월/);
  assert.match(app, /selectedSignals\.slice\(0,\s*3\)/);
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
  assert.equal(
    [...app.matchAll(/\['buy', 'sell'\]\.includes\(signalBucket\(row\)\)/g)].length,
    2,
  );
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
