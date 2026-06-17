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
const selected = parsed.etfs[0];
const series = api.buildWeightSeries(selected.history, selected.latest?.top10 || []);
if (selected.history.length && !series.length) throw new Error('weight series missing for tracked history');
const decompositionKeys = new Set((selected.latest?.decomposition || []).map((row) => api.holdingKey(row)));
for (const holding of selected.latest?.top10 || []) {
  if (!decompositionKeys.has(api.holdingKey(holding))) throw new Error(`top10 holding missing decomposition row: ${api.holdingKey(holding)}`);
}
const sortedRows = api.sortAttributionRows(selected.latest?.decomposition || []);
if (sortedRows.length && sortedRows[0].displayScope !== 'current_top10') throw new Error('decomposition rows should show current TOP10 first');
if (api.QUANT_DASHBOARD_URL !== 'https://sonchanggi.github.io/quant-dashboard/') throw new Error('return dashboard URL changed');
if (api.AUTOMATION_STATUS_URL !== 'data/automation-status.json') throw new Error('automation status URL changed');
if (api.formatPriceSource('provider_valuation_krw') !== 'ETF KRW 평가단가') throw new Error('KRW valuation source label changed');
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
  if (!html.includes('https://sonchanggi.github.io/quant-dashboard/')) throw new Error('quant dashboard return link missing');
  if (!app.includes('buildWeightSeries')) throw new Error('chart series builder missing');
  if (!data.etfs || data.etfs.length !== 3) throw new Error('dashboard JSON ETF count invalid');
  console.log('PASS static server smoke served ETF tracker shell and data');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
