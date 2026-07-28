import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../assets/styles.css', import.meta.url), 'utf8');
const sharedNav = readFileSync(new URL('../assets/shared-nav.css', import.meta.url), 'utf8');
const platformSource = readFileSync(
  new URL('../shared-platform/dist/index.js', import.meta.url),
  'utf8',
);

function dashboardHelpers() {
  const context = vm.createContext({
    AbortController,
    URL,
    clearTimeout,
    console,
    setTimeout,
  });
  vm.runInContext(platformSource, context, {
    filename: 'shared-platform/dist/index.js',
  });
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

test('common design v1.2 keeps the compact type hierarchy and nine unique project destinations', () => {
  assert.match(styles, /body\s*\{[^}]*font-size:\s*15px;[^}]*line-height:\s*1\.55;/s);
  assert.match(styles, /h1\s*\{[^}]*font-size:\s*clamp\(2rem,\s*4vw,\s*3\.25rem\)/s);
  assert.match(styles, /h2\s*\{[^}]*font-size:\s*clamp\(1\.35rem,\s*2\.3vw,\s*1\.8rem\)/s);
  assert.doesNotMatch(styles, /font-weight:\s*(?:8\d\d|9\d\d)/);

  const nav = html.match(/<div class="quant-shared-nav__links"[\s\S]*?<\/div>/)?.[0] || '';
  const links = [...nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  assert.equal(links.length, 8);
  assert.deepEqual(
    links.map((match) => match[2].replace(/&amp;/g, '&').trim()),
    ['Fear & Greed', 'Momentum', 'DRAM', 'Best Factor', 'ETF', 'SOX', 'Port', 'Kelly'],
  );
  assert.equal(links.filter((match) => /aria-current="page"/.test(match[0])).length, 1);
  assert.match(links[4][0], /aria-current="page"/);
  assert.equal(links[7][1], 'https://sonchanggi.github.io/kelly/');
  assert.match(
    html,
    /class="quant-shared-nav__brand"[^>]+href="https:\/\/sonchanggi\.github\.io\/quant-dashboard\/"/,
  );
  assert.match(sharedNav, /\.quant-shared-nav\s*\{[\s\S]*?position:\s*fixed\s*!important;/);
  assert.match(sharedNav, /body\.has-quant-shared-nav\s*\{[^}]*padding-top:\s*var\(--quant-shared-nav-height\)/);
  assert.match(sharedNav, /@media \(max-width:\s*760px\)[\s\S]*?--quant-shared-nav-height:\s*101px/);
  assert.match(app, /ensureActiveProjectVisible\(\)/);
  assert.match(app, /scrollIntoView\?\.\(\{[\s\S]*?inline:\s*'center'/);
});

test('implementation notes live in one closed operations disclosure', () => {
  assert.match(html, /<details[^>]*id="operations-detail"[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b[^>]*id="operations-detail"/);
  const operationsStart = html.indexOf('id="operations-detail"');
  const operationsEnd = html.indexOf('</details>', operationsStart);
  for (const id of ['source-detail', 'methodology', 'research-notice', 'manual-update']) {
    const index = html.indexOf(`id="${id}"`);
    assert.ok(index > operationsStart && index < operationsEnd);
  }
  assert.doesNotMatch(html, /Common Design v1/);
  assert.doesNotMatch(html, /기존 Python 분류값/);
  assert.doesNotMatch(html, /필요할 때만 상세 히스토리를 불러옵니다/);
});

test('visible copy stays result-specific while chart mechanics remain accessible', () => {
  for (const text of [
    '선택 ETF의 최신 구성, 비중 변화와 가격으로 설명되지 않는 관찰 신호를 먼저 보여줍니다.',
    '종목과 날짜를 선택해 정확한 비중을 확인합니다.',
    '← → 날짜 이동',
    '조회 기간을 바꿉니다.',
  ]) {
    assert.doesNotMatch(html, new RegExp(text));
  }
  assert.match(
    html,
    /id="weight-chart"[^>]*tabindex="0"[^>]*aria-describedby="weight-chart-help"[^>]*aria-keyshortcuts="ArrowLeft ArrowRight Home End"/,
  );
  assert.match(html, /id="weight-chart-help" class="sr-only"/);
  assert.match(app, /svg\.addEventListener\('pointermove'/);
  assert.match(app, /svg\.addEventListener\('click'/);
  assert.match(app, /target\.onkeydown = \(event\) =>/);
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.match(app, new RegExp(`event\\.key === '${key}'`));
  }
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

test('pointer hit-testing uses the same elapsed-time scale as irregular date rendering', () => {
  const helpers = dashboardHelpers();
  const dates = ['2026-01-01', '2026-01-02', '2026-01-30'];
  const minDate = Date.parse(dates[0]);
  const maxDate = Date.parse(dates.at(-1));
  assert.equal(helpers.chartDateForSvgX(dates, 100, minDate, maxDate, 100, 800), dates[0]);
  assert.equal(helpers.chartDateForSvgX(dates, 900, minDate, maxDate, 100, 800), dates.at(-1));
  assert.equal(
    helpers.chartDateForSvgX(dates, 100 + 800 * 0.52, minDate, maxDate, 100, 800),
    '2026-01-30',
  );
  assert.match(app, /svgPointFromClient\(svg,\s*event\.clientX,\s*event\.clientY/);
  assert.match(app, /svg\.addEventListener\('click',\s*\(event\)\s*=>/);
  assert.doesNotMatch(app, /const preview = state\.chartSelection\.previewDate/);
});

test('SVG client coordinates stay correct through responsive scale and horizontal scroll transforms', () => {
  const helpers = dashboardHelpers();
  const svg = {
    createSVGPoint() {
      return {
        x: 0,
        y: 0,
        matrixTransform(matrix) {
          return matrix.transformPoint(this);
        },
      };
    },
    getScreenCTM() {
      return {
        inverse() {
          return {
            transformPoint(point) {
              return {
                x: (point.x + 200) / 0.5,
                y: (point.y - 20) / 0.5,
              };
            },
          };
        },
      };
    },
  };
  assert.deepEqual(
    { ...helpers.svgPointFromClient(svg, 250, 120, 1080, 470) },
    { x: 900, y: 200 },
  );
  assert.match(app, /screenPoint\.x - scrollRect\.left \+ scrollRoot\.scrollLeft/);
});

test('date range validation fails closed and binds the cutoff to one stored snapshot', () => {
  const helpers = dashboardHelpers();
  const history = [
    { date: '2026-07-01', top10: [{ ticker: 'A' }] },
    { date: '2026-07-10', top10: [{ ticker: 'B' }] },
    { date: '2026-07-24', top10: [{ ticker: 'C' }] },
  ];
  const etf = {
    historyLoaded: true,
    historyError: '',
    availableStartDate: '2026-07-01',
    availableEndDate: '2026-07-24',
    history,
    latest: history.at(-1),
  };
  const ready = helpers.selectedRangeContext(etf, '2026-07-01', '2026-07-20');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.snapshot.date, '2026-07-10');
  assert.equal(ready.appliedEnd, '2026-07-10');

  for (const [start, end] of [
    ['2026-07-20', '2026-07-01'],
    ['2026-07-11', '2026-07-19'],
    ['', '2026-07-20'],
    ['2026-06-30', '2026-07-20'],
  ]) {
    const invalid = helpers.selectedRangeContext(etf, start, end);
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.snapshot, null);
  }
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

test('control registry distinguishes display dates from the result cutoff selector', () => {
  const context = vm.createContext({
    AbortController,
    URL,
    clearTimeout,
    console,
    setTimeout,
  });
  vm.runInContext(platformSource, context, {
    filename: 'shared-platform/dist/index.js',
  });
  const controls = new Map(
    context.__ETF_SHARED_PLATFORM__.etfControlManifest.controls.map(
      (control) => [control.id, control.controlKind],
    ),
  );
  assert.equal(controls.get('chart_observation_date'), 'display');
  assert.equal(controls.get('range_start'), 'display');
  assert.equal(controls.get('range_preset'), 'display');
  assert.equal(controls.get('range_end'), 'result_selector');
});

test('theme storage uses the shared key while retaining ETF migration', () => {
  assert.match(app, /const THEME_STORAGE_KEY = 'quant-research-theme'/);
  assert.match(app, /'etf-tracking-theme'/);
});

test('pinned platform seam loads before the app and exposes canonical token aliases', () => {
  const platformScript = html.indexOf('shared-platform/dist/index.js?v=0.1.0');
  const appScript = html.indexOf('assets/app.js?v=20260724-platform-compat');
  assert.ok(platformScript > 0);
  assert.ok(appScript > platformScript);
  assert.match(
    html,
    /data-platform-version="quant-platform-frontend\/0\.1\.0"/,
  );
  for (const token of [
    '--qr-bg',
    '--qr-surface',
    '--qr-text',
    '--qr-primary',
    '--qr-positive',
    '--qr-warning',
    '--qr-negative',
    '--qr-chart-grid',
  ]) {
    assert.match(styles, new RegExp(token.replaceAll('-', '\\-')));
  }
});

test('visible ETF controls cannot submit analysis or config runs', () => {
  const context = vm.createContext({
    AbortController,
    URL,
    clearTimeout,
    console,
    setTimeout,
  });
  vm.runInContext(platformSource, context, {
    filename: 'shared-platform/dist/index.js',
  });
  const manifest = context.__ETF_SHARED_PLATFORM__.etfControlManifest;
  assert.equal(
    manifest.controls.filter((control) => control.controlKind === 'analysis')
      .length,
    0,
  );
  assert.deepEqual(
    Array.from(
      manifest.controls
        .filter((control) => control.controlKind === 'operation')
        .map((control) => control.id),
    ),
    ['owner_refresh_backfill'],
  );
  assert.doesNotMatch(app, /fetch\s*\(/);
  assert.doesNotMatch(
    `${app}\n${platformSource}`,
    /\/v1\/projects\/[^/]+\/runs|\/v1\/runs\/|method:\s*['"]POST['"]/,
  );
});

test('every static and generated interactive element is bound to the control registry', () => {
  const context = vm.createContext({
    AbortController,
    URL,
    clearTimeout,
    console,
    setTimeout,
  });
  vm.runInContext(platformSource, context, {
    filename: 'shared-platform/dist/index.js',
  });
  const registered = new Set(
    context.__ETF_SHARED_PLATFORM__.etfControlManifest.controls.map(
      (control) => control.id,
    ),
  );
  const interactivePattern = /<(?:a|button|input|select|summary)\b[^>]*>/g;
  for (const [sourceName, markup] of [
    ['index.html', html],
    ['assets/app.js templates', app],
  ]) {
    const elements = [...markup.matchAll(interactivePattern)].map(
      (match) => match[0],
    );
    assert.ok(elements.length > 0, `${sourceName} interactive elements missing`);
    for (const element of elements) {
      const controlId = /data-control-id="([^"]+)"/.exec(element)?.[1];
      assert.ok(controlId, `${sourceName} control annotation missing: ${element}`);
      assert.ok(
        registered.has(controlId),
        `${sourceName} uses unknown control id: ${controlId}`,
      );
    }
  }
  for (const id of ['manual-update-link', 'copy-update-command']) {
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*data-control-id="owner_refresh_backfill"`),
    );
  }
});
