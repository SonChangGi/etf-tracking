import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import vm from 'node:vm';

for (const file of ['index.html', 'assets/app.js', 'assets/styles.css', 'data/dashboard.json', 'data/summary.json', 'data/history.json', 'data/status.json', 'data/automation-status.json']) {
  if (!existsSync(file)) throw new Error(`${file} missing`);
}
if (!existsSync('data/history')) throw new Error('data/history directory missing');

const source = readFileSync('assets/app.js', 'utf8');
const styles = readFileSync('assets/styles.css', 'utf8');
if (/class="chart-legend"|renderChartLegend/.test(source)) {
  throw new Error('weight chart should not render duplicate legend and summary cards');
}
if (!/\.chart-summary-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s.test(styles)) {
  throw new Error('weight chart summary should use a five-column desktop grid for 1-5 / 6-10 rows');
}
const context = vm.createContext({ console });
vm.runInContext(source, context, { filename: 'assets/app.js' });
const api = context.__ETF_TRACKING_TESTS__;
if (!api) throw new Error('ETF tracking test API missing');
const dashboardRaw = readFileSync('data/dashboard.json', 'utf8');
const dashboardBytes = statSync('data/dashboard.json').size;
if (dashboardBytes > 5_000_000) throw new Error(`dashboard payload should stay slim for first paint, got ${dashboardBytes} bytes`);
const summaryPayload = JSON.parse(readFileSync('data/summary.json', 'utf8'));
if (summaryPayload.contract !== 'quant-research-summary' || summaryPayload.projectId !== 'etf') {
  throw new Error('summary.json should expose the quant research summary contract for ETF Tracking');
}
if (!Array.isArray(summaryPayload.primaryEntities) || !summaryPayload.primaryEntities.length) {
  throw new Error('summary.json should expose ticker/entity entries for the dashboard dossier');
}
if (summaryPayload.primaryEntities.length < 10) {
  throw new Error(`summary.json should keep a useful publication floor, got ${summaryPayload.primaryEntities.length} entities`);
}
if (!summaryPayload.limitations?.some((text) => String(text).includes('가능성 신호'))) {
  throw new Error('summary.json should preserve residual signal limitation language');
}
const historyRaw = readFileSync('data/history.json', 'utf8');
const historyManifestBytes = statSync('data/history.json').size;
if (historyManifestBytes > 1_000_000) throw new Error(`history manifest should stay slim, got ${historyManifestBytes} bytes`);
const historyFiles = readdirSync('data/history').filter((name) => name.endsWith('.json')).sort();
if (historyFiles.length !== 3) throw new Error('expected one per-ETF history JSON for each tracked ETF');
for (const internalKey of ['priceDiagnostics', 'priceMeta', 'sourceFields']) {
  if (dashboardRaw.includes(internalKey)) throw new Error(`dashboard payload leaked internal diagnostic key: ${internalKey}`);
  if (historyRaw.includes(internalKey)) throw new Error(`history manifest leaked internal diagnostic key: ${internalKey}`);
}
const historyManifest = JSON.parse(historyRaw);
if (Object.hasOwn(historyManifest, 'diagnostics')) throw new Error('public history manifest should not include run diagnostics');
if (!Array.isArray(historyManifest.etfs)) throw new Error('history.json should be a manifest, not the full monolithic history map');
const parsed = api.parseDashboard(JSON.parse(dashboardRaw));
for (const etf of parsed.etfs) {
  if (!etf.historyUrl?.startsWith('data/history/')) throw new Error(`${etf.id} missing per-ETF historyUrl`);
  if (etf.history.length !== 0) throw new Error(`${etf.id} should not embed full history in dashboard.json`);
  const historyPath = etf.historyUrl;
  if (!existsSync(historyPath)) throw new Error(`${historyPath} missing`);
  const perEtfRaw = readFileSync(historyPath, 'utf8');
  const perEtfBytes = statSync(historyPath).size;
  if (perEtfBytes > 50_000_000) throw new Error(`${historyPath} exceeds GitHub Pages large-file practical limit`);
  for (const internalKey of ['priceDiagnostics', 'priceMeta', 'sourceFields']) {
    if (perEtfRaw.includes(internalKey)) throw new Error(`${historyPath} leaked internal diagnostic key: ${internalKey}`);
  }
  const perEtfPayload = JSON.parse(perEtfRaw);
  if (!Array.isArray(perEtfPayload.history)) throw new Error(`${historyPath} missing history array`);
  if (!perEtfPayload.history.every((row) => row.queryDate || row.date)) throw new Error(`${historyPath} should preserve replay query/date metadata`);
  api.applyHistoryPayload(etf, perEtfPayload);
}
if (parsed.etfs.length !== 3) throw new Error('dashboard must expose three ETFs');
if (!parsed.etfs.some((etf) => etf.id === 'koact-nasdaq-growth-active')) throw new Error('KoAct ETF missing');
if (!parsed.historyPolicy?.scheduledLookbackDays) throw new Error('dashboard history policy missing');
if (parsed.historyPolicy?.missingOnlyDefault !== true) throw new Error('missing-only history policy missing');
if (!parsed.historyPolicy?.startDateExplanation?.includes('2026-04-01은 공급자 한계가 아니라')) throw new Error('history policy should explain that 2026-04-01 was not the provider limit');
const expectedStarts = new Map([
  ['time-nasdaq100-active', '2022-05-11'],
  ['time-global-ai-active', '2023-05-16'],
  ['koact-nasdaq-growth-active', '2025-02-25'],
]);
for (const [etfId, expectedStart] of expectedStarts) {
  const etf = parsed.etfs.find((item) => item.id === etfId);
  if (etf?.availableStartDate !== expectedStart) throw new Error(`${etfId} should expose listing-date historical start ${expectedStart}`);
  if (etf?.sourceAvailability?.oldestStoredDate !== expectedStart) throw new Error(`${etfId} source availability should start at listing date`);
  if (etf?.sourceAvailability?.storedFromListingDate !== true) throw new Error(`${etfId} should report listing-date backfill coverage`);
}
if (parsed.manualUpdatePolicy?.workflowUrl !== 'https://github.com/SonChangGi/etf-tracking/actions/workflows/update-data.yml') {
  throw new Error('manual update workflow policy missing');
}
const selected = parsed.etfs[0];
const sourceAvailabilityText = api.formatSourceAvailability(selected.sourceAvailability);
const selectedCoverage = Number(selected.sourceAvailability?.coverageRatioThroughLatest);
if (Number.isFinite(selectedCoverage) && selectedCoverage < 0.9 && sourceAvailabilityText.summary.includes('상장일부터 저장')) {
  throw new Error('source availability label should not overstate sparse or partial coverage as continuous storage');
}
if (selected.sourceAvailability?.storedFromListingDate && Number.isFinite(selectedCoverage) && selectedCoverage < 0.5 && !sourceAvailabilityText.summary.includes('희소')) {
  throw new Error('sparse listing-date coverage should be labeled as 희소 백필');
}
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
const koact = parsed.etfs.find((etf) => etf.id === 'koact-nasdaq-growth-active');
const allSeries = parsed.etfs.flatMap((etf) => api.buildWeightSeries(etf.history, etf.latest?.top10 || []));
if (!allSeries.some((item) => item.signalPoints.some((point) => point.kind === 'entry' && point.actionEstimate === 'top10_entry' && point.glyph === '＋'))) {
  throw new Error('hover chart should show TOP10 entry markers for current provider data, without depending on a specific holding name');
}
if (!allSeries.some((item) => item.signalPoints.some((point) => point.kind === 'entry' && point.actionEstimate === 'new_entry'))) {
  throw new Error('hover chart should show 신규 편입 markers when no residual buy estimate exists for visible current TOP10 holdings');
}
if (api.lifecycleDirection({ classification: 'new_entry', holdingLifecycle: 'new_holding' })?.kind !== 'entry') throw new Error('new_entry should map to an entry marker');
if (api.lifecycleDirection({ membershipChange: 'top10_entry' })?.glyph !== '＋') throw new Error('top10_entry should map to plus marker');
if (api.lifecycleDirection({ membershipChange: 'top10_exit' })?.kind !== 'exit') throw new Error('top10_exit should map to exit marker');
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
const selectedSignalRows = api.buildEtfSignalTableRows(selected, selected.availableStartDate, selected.availableEndDate);
const selectedSignalCounts = api.signalTableCounts(selectedSignalRows);
if (!selectedSignalRows.length || selectedSignalCounts.entry < 1 || selectedSignalCounts.exit < 1) {
  throw new Error('ETF signal table should include selected-period TOP10 entry/exit rows');
}
const selectedEntryRow = selectedSignalRows.find((row) => api.signalBucket(row) === 'entry' && (row.name || row.ticker));
if (!selectedEntryRow) {
  throw new Error('ETF signal table should expose at least one named current TOP10 entry row');
}
const selectedEntryQuery = String(selectedEntryRow.name || selectedEntryRow.ticker).split(/\s+/)[0];
const defaultSignalFilter = api.signalTableDefaultFilter();
if (defaultSignalFilter.bucket !== 'signal' || defaultSignalFilter.limit !== 30) {
  throw new Error('ETF signal table should default to a compact core-signal view');
}
const defaultFilteredRows = api.filterSignalTableRows(selectedSignalRows, defaultSignalFilter);
if (!defaultFilteredRows.length || defaultFilteredRows.some((row) => api.signalBucket(row) === 'neutral')) {
  throw new Error('ETF signal table default filter should hide neutral TOP10 rows');
}
const entryFilteredRows = api.filterSignalTableRows(selectedSignalRows, { ...defaultSignalFilter, bucket: 'entry' });
if (!entryFilteredRows.length || entryFilteredRows.some((row) => api.signalBucket(row) !== 'entry')) {
  throw new Error('ETF signal table event filter should isolate entry rows');
}
const queryFilteredRows = api.filterSignalTableRows(selectedSignalRows, { ...defaultSignalFilter, bucket: 'all', query: selectedEntryQuery });
if (!queryFilteredRows.some((row) => row.name === selectedEntryRow.name || row.ticker === selectedEntryRow.ticker)) {
  throw new Error('ETF signal table query filter should match current entry holdings by name/ticker');
}
const residualFilteredRows = api.filterSignalTableRows(selectedSignalRows, { ...defaultSignalFilter, bucket: 'all', magnitude: 'residual_010' });
if (!residualFilteredRows.length || residualFilteredRows.some((row) => Math.abs(row.deltaResidualPercentPoint || 0) < 0.1)) {
  throw new Error('ETF signal table residual magnitude filter should keep meaningful residual rows only');
}
const residualSortedRows = api.filterSignalTableRows(selectedSignalRows, { ...defaultSignalFilter, bucket: 'all', sort: 'residual_delta' });
if (residualSortedRows.length > 1 && Math.abs(residualSortedRows[0].deltaResidualPercentPoint || 0) < Math.abs(residualSortedRows[1].deltaResidualPercentPoint || 0)) {
  throw new Error('ETF signal table residual sort should put larger residuals first');
}
const koactSignalRows = api.buildEtfSignalTableRows(koact, koact.availableStartDate, koact.availableEndDate);
const koactSignalCounts = api.signalTableCounts(koactSignalRows);
if (!koactSignalRows.some((row) => /Space Exploration Technologies/i.test(row.name) && row.classification === 'new_entry' && api.signalBucket(row) === 'entry')) {
  throw new Error('ETF signal table should show 신규 편입 rows when residual buy is unavailable');
}
if (koactSignalCounts.buy < 1 || koactSignalCounts.sell < 1) {
  throw new Error('ETF signal table should count buy and sell observations');
}
const fullSignalSnapshot = api.setDashboardForTests(parsed);
const selectedFullRows = fullSignalSnapshot.signalTableRows.find((item) => item.etfId === selected.id)?.rows || 0;
const selectedFullTable = fullSignalSnapshot.signalTableRows.find((item) => item.etfId === selected.id);
if (!(selectedFullTable?.filteredRows < selectedFullTable?.rows && selectedFullTable?.visibleRows <= 30)) {
  throw new Error('ETF signal table snapshot should expose compact filtered/visible row counts');
}
const querySnapshot = api.setSignalTableFilterForTests(selected.id, { bucket: 'all', query: 'Space' });
const queryTable = querySnapshot.signalTableRows.find((item) => item.etfId === selected.id);
if (!queryTable?.filteredRows || queryTable.filteredRows >= selectedFullRows) {
  throw new Error('ETF signal table controls should narrow rows by query');
}
api.handleDateRangeChange('startDate', selected.availableEndDate);
const narrowedSignalSnapshot = api.stateSnapshotForTests();
const selectedNarrowRows = narrowedSignalSnapshot.signalTableRows.find((item) => item.etfId === selected.id)?.rows || 0;
if (!(selectedNarrowRows > 0 && selectedNarrowRows < selectedFullRows)) {
  throw new Error('ETF signal tables should recompute when the selected date range changes');
}
api.handleEtfSelectionChange('koact-nasdaq-growth-active');
const switchedSignalSnapshot = api.stateSnapshotForTests();
if (switchedSignalSnapshot.selectedEtfId !== 'koact-nasdaq-growth-active') {
  throw new Error('ETF signal tables should preserve selected ETF changes through the shared handler');
}
if (!switchedSignalSnapshot.signalTableRows.some((item) => item.etfId === 'koact-nasdaq-growth-active' && item.rows > 0)) {
  throw new Error('ETF signal tables should keep all ETF cards after ETF selection changes');
}
api.handleDateRangeReset();
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
  const firstHistoryUrl = data.etfs?.[0]?.historyUrl;
  const firstHistory = firstHistoryUrl ? await fetch(`http://127.0.0.1:${port}/${firstHistoryUrl}`).then((response) => response.json()) : null;
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
  if (!app.includes('lifecycleDirection') || !styles.includes('signal-entry')) throw new Error('chart lifecycle entry markers missing');
  if (!html.includes('marker-entry') || !html.includes('＋ 편입')) throw new Error('chart marker UX legend missing');
  if (!html.includes('etf-signal-tables') || !html.includes('ETF별 TOP10 신호·비중 변화 표')) throw new Error('ETF signal table shell missing');
  if (!app.includes('renderSignalTables') || !app.includes('buildEtfSignalTableRows') || !app.includes('filterSignalTableRows')) throw new Error('ETF signal table renderer missing');
  if (!app.includes('setupSignalTableLazyLoad') || !app.includes('data-load-etf-history')) throw new Error('ETF histories should load lazily for signal tables');
  if (app.includes('preloadRemainingEtfHistories')) throw new Error('ETF histories should not be eagerly preloaded after first paint');
  if (!app.includes('data-signal-filter') || !app.includes('data-signal-bucket')) throw new Error('ETF signal table filter controls missing');
  if (!styles.includes('signal-table-card') || !styles.includes('signal-count-strip') || !styles.includes('signal-filter-grid')) throw new Error('ETF signal table styles missing');
  if (!app.includes('copyManualUpdateCommand')) throw new Error('manual update copy helper missing');
  if (!data.etfs || data.etfs.length !== 3) throw new Error('dashboard JSON ETF count invalid');
  if (data.etfs.some((etf) => Array.isArray(etf.history))) throw new Error('dashboard JSON should not embed ETF history arrays');
  if (!firstHistory?.history?.length) throw new Error('per-ETF history JSON should be served by the static server');
  if (!data.manualUpdatePolicy?.cliCommand?.includes('workflow run update-data.yml')) throw new Error('dashboard manual update policy invalid');
  console.log('PASS static server smoke served ETF tracker shell and data');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
