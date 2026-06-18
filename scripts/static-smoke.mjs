import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import vm from 'node:vm';

for (const file of ['index.html', 'assets/app.js', 'assets/styles.css', 'data/dashboard.json', 'data/status.json', 'data/automation-status.json']) {
  if (!existsSync(file)) throw new Error(`${file} missing`);
}

const source = readFileSync('assets/app.js', 'utf8');
const context = vm.createContext({ console });
vm.runInContext(source, context, { filename: 'assets/app.js' });
const api = context.__ETF_TRACKING_TESTS__;
if (!api) throw new Error('ETF tracking test API missing');
const parsed = api.parseDashboard(JSON.parse(readFileSync('data/dashboard.json', 'utf8')));
if (parsed.etfs.length !== 3) throw new Error('dashboard must expose three ETFs');
if (!parsed.etfs.some((etf) => etf.id === 'koact-nasdaq-growth-active')) throw new Error('KoAct ETF missing');
if (!parsed.historyPolicy?.scheduledLookbackDays) throw new Error('dashboard history policy missing');
if (parsed.historyPolicy?.missingOnlyDefault !== true) throw new Error('missing-only history policy missing');
if (parsed.manualUpdatePolicy?.workflowUrl !== 'https://github.com/SonChangGi/etf-tracking/actions/workflows/update-data.yml') {
  throw new Error('manual update workflow policy missing');
}
const selected = parsed.etfs[0];
const series = api.buildWeightSeries(selected.history, selected.latest?.top10 || []);
if (selected.history.length && !series.length) throw new Error('weight series missing for tracked history');
const sndkSeries = series.find((item) => item.key === 'SNDK');
if (!sndkSeries?.signalPoints.some((point) => point.actionEstimate === 'weak_sell_watch' && point.direction === 'sell')) {
  throw new Error('hover chart should carry selected-period residual sell-watch markers for SNDK');
}
if (!sndkSeries.signalPoints.some((point) => point.actionEstimate === 'likely_buy' && point.direction === 'buy')) {
  throw new Error('hover chart should include selected-period buy markers, not just residual watches');
}
if (!sndkSeries.signalPoints.some((point) => point.actionEstimate === 'likely_sell' && point.direction === 'sell')) {
  throw new Error('hover chart should include selected-period sell markers, not just residual watches');
}
if (api.residualDirection({ actionEstimate: 'likely_buy' })?.direction !== 'buy') throw new Error('likely_buy should map to up-arrow buy direction');
if (api.residualDirection({ classification: 'residual_watch', deltaResidualPercentPoint: -0.2 })?.direction !== 'sell') throw new Error('negative residual_watch should map to down-arrow sell direction');
const segmented = api.splitPointSegments([
  { date: '2026-06-15', value: 1 },
  { date: '2026-06-16', value: null },
  { date: '2026-06-17', value: 2 },
]);
if (segmented.length !== 2) throw new Error('weight chart should not connect through missing holdings');
const colorMap = api.buildSeriesColorMap(series);
const visibleColors = series.map((item) => colorMap.get(item.key));
if (new Set(visibleColors).size !== visibleColors.length) throw new Error('visible chart series colors should not overlap');
const weightTicks = api.buildNiceTicks(0, 2.82, 6);
if (!weightTicks.includes(3) || weightTicks.includes(2.82)) throw new Error('weight axis ticks should use nice readable bounds');
const dateTicks = api.buildDateTicks(selected.history.map((row) => row.date), 14);
if (selected.history.length > 2 && dateTicks.length < 3) throw new Error('date axis should include intermediate ticks');
if (dateTicks[0] !== selected.history[0]?.date || dateTicks.at(-1) !== selected.history.at(-1)?.date) throw new Error('date axis should keep first and last dates');
if (dateTicks.includes('2026-06-15') && dateTicks.includes('2026-06-17')) throw new Error('date axis should not crowd near-end labels');
const holidayAdjustedTicks = api.buildDateTicks([
  '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
  '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12',
  '2026-06-16', '2026-06-17',
], 5);
if (!holidayAdjustedTicks.includes('2026-06-09')) throw new Error('date axis should snap cadence to available trading dates');
if (api.formatAxisDate('2026-06-17') !== '06.17') throw new Error('axis date label format changed');
const decompositionKeys = new Set((selected.latest?.decomposition || []).map((row) => api.holdingKey(row)));
for (const holding of selected.latest?.top10 || []) {
  if (!decompositionKeys.has(api.holdingKey(holding))) throw new Error(`top10 holding missing decomposition row: ${api.holdingKey(holding)}`);
}
const sortedRows = api.sortAttributionRows(selected.latest?.decomposition || []);
if (sortedRows.length && sortedRows[0].displayScope !== 'current_top10') throw new Error('decomposition rows should show current TOP10 first');
if (api.QUANT_DASHBOARD_URL !== 'https://sonchanggi.github.io/quant-dashboard/') throw new Error('return dashboard URL changed');
if (api.AUTOMATION_STATUS_URL !== 'data/automation-status.json') throw new Error('automation status URL changed');
if (api.WORKFLOW_URL !== 'https://github.com/SonChangGi/etf-tracking/actions/workflows/update-data.yml') throw new Error('workflow URL changed');
if (!api.MANUAL_UPDATE_COMMAND?.includes('refresh_existing=false')) throw new Error('manual update command changed');
if (api.formatPriceSource('provider_valuation_krw') !== 'ETF KRW 평가단가') throw new Error('KRW valuation source label changed');
if (api.formatPriceSource('fx_adjusted_external_close') !== '외부 종가+환율') throw new Error('FX-adjusted source label changed');
if (api.formatCoverageUniverse('priced_subset_of_full_holdings') !== '전체 보유종목 중 가격확보분') throw new Error('coverage universe label changed');
if (api.classLabel('price_aligned') !== '가격 우세') throw new Error('price-aligned label should avoid overclaiming full explanation');
if (api.classLabel('residual_watch') !== '잔차 관찰') throw new Error('residual watch label missing');
const residualWatch = api.actionHint({ classification: 'residual_watch', deltaResidualPercentPoint: -0.26, actionLabel: '', actionExplanation: '' });
if (residualWatch.label !== '약한 매도·축소 관찰') throw new Error('residual watch should expose weak buy/sell direction');
const automation = api.normalizeAutomationStatus(JSON.parse(readFileSync('data/automation-status.json', 'utf8')));
if (!automation?.runStatus) throw new Error('automation status missing runStatus');

const root = process.cwd();
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const safePath = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = join(root, safePath);
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': types.get(extname(filePath)) || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const [html, app, data] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()),
    fetch(`http://127.0.0.1:${port}/assets/app.js`).then((response) => response.text()),
    fetch(`http://127.0.0.1:${port}/data/dashboard.json`).then((response) => response.json()),
  ]);
  if (!html.includes('ETF TOP10 투자 비중 추적')) throw new Error('index hero missing');
  if (!html.includes('히스토리 범위')) throw new Error('history range explanation missing');
  if (!html.includes('없는 날짜만 채우는 수동 업데이트')) throw new Error('manual update section missing');
  if (!html.includes('GitHub Actions에서 수동 업데이트 열기')) throw new Error('manual update CTA missing');
  if (!html.includes('https://sonchanggi.github.io/quant-dashboard/')) throw new Error('quant dashboard return link missing');
  if (!app.includes('buildWeightSeries')) throw new Error('chart series builder missing');
  if (!app.includes('buildSeriesColorMap')) throw new Error('chart color collision guard missing');
  if (!app.includes('buildNiceTicks')) throw new Error('nice axis tick builder missing');
  if (!app.includes('axis-range')) throw new Error('chart axis range label missing');
  if (!app.includes('chart-series') || !app.includes('series-hit')) throw new Error('chart hover emphasis missing');
  if (!app.includes('copyManualUpdateCommand')) throw new Error('manual update copy helper missing');
  if (!data.etfs || data.etfs.length !== 3) throw new Error('dashboard JSON ETF count invalid');
  if (!data.manualUpdatePolicy?.cliCommand?.includes('workflow run update-data.yml')) throw new Error('dashboard manual update policy invalid');
  console.log('PASS static server smoke served ETF tracker shell and data');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
