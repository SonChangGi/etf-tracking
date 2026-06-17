(() => {
  'use strict';

  const DATA_URL = 'data/dashboard.json';
  const STATUS_URL = 'data/status.json';
  const AUTOMATION_STATUS_URL = 'data/automation-status.json';
  const QUANT_DASHBOARD_URL = 'https://sonchanggi.github.io/quant-dashboard/';
  const WORKFLOW_URL = 'https://github.com/SonChangGi/etf-tracking/actions/workflows/update-data.yml';
  const MANUAL_UPDATE_COMMAND = 'gh workflow run update-data.yml --repo SonChangGi/etf-tracking --ref main -f backfill_all=false -f backfill_start_date= -f refresh_existing=false -f strict_validation=false';
  const CHART_COLORS = [
    '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed',
    '#0891b2', '#db2777', '#4d7c0f', '#92400e', '#111827',
    '#0f766e', '#be123c', '#4338ca', '#0369a1', '#a16207',
    '#15803d', '#c2410c', '#7f1d1d', '#581c87', '#0e7490',
  ];
  const $ = (selector) => (typeof document === 'undefined' ? null : document.querySelector(selector));

  const state = {
    dashboard: null,
    selectedEtfId: null,
    startDate: '',
    endDate: '',
  };

  const FALLBACK_DASHBOARD = {
    schemaVersion: 'fallback',
    generatedAt: '',
    disclaimer: 'Fallback snapshot; public JSON could not be loaded.',
    historyPolicy: {
      scheduledLookbackDays: 10,
      startDateExplanation: '공개 JSON을 불러오지 못해 fallback 화면을 표시 중입니다.',
    },
    manualUpdatePolicy: {
      workflowUrl: WORKFLOW_URL,
      cliCommand: MANUAL_UPDATE_COMMAND,
      defaultMode: 'missing_only',
    },
    etfs: [
      {
        id: 'time-nasdaq100-active',
        name: 'TIME 미국나스닥100액티브',
        shortName: 'TIME 나스닥100',
        code: '426030',
        provider: 'TIME ETF',
        sourceUrl: 'https://timeetf.co.kr/m11_view.php?idx=2&cate=001',
        latest: null,
        history: [],
        signals: [],
        metrics: { top10Count: 0, signalCount: 0, returnCoverageStatus: 'fallback' },
      },
      {
        id: 'time-global-ai-active',
        name: 'TIME 글로벌AI인공지능액티브',
        shortName: 'TIME 글로벌AI',
        code: '456600',
        provider: 'TIME ETF',
        sourceUrl: 'https://timeetf.co.kr/m11_view.php?idx=6&cate=001',
        latest: null,
        history: [],
        signals: [],
        metrics: { top10Count: 0, signalCount: 0, returnCoverageStatus: 'fallback' },
      },
      {
        id: 'koact-nasdaq-growth-active',
        name: 'KoAct 미국나스닥성장기업액티브',
        shortName: 'KoAct 나스닥성장',
        code: '2ETFQ1',
        provider: '삼성액티브자산운용',
        sourceUrl: 'https://www.samsungactive.co.kr/etf/view.do?id=2ETFQ1',
        latest: null,
        history: [],
        signals: [],
        metrics: { top10Count: 0, signalCount: 0, returnCoverageStatus: 'fallback' },
      },
    ],
    signals: [],
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      wireControls();
      loadAndRender();
    });
  }

  async function loadAndRender() {
    const target = $('#data-status');
    try {
      const [dashboardResult, statusResult, automationResult] = await Promise.all([
        getJsonBestEffort(DATA_URL),
        getJsonBestEffort(STATUS_URL),
        getJsonBestEffort(AUTOMATION_STATUS_URL),
      ]);
      const dashboard = parseDashboard(dashboardResult.ok ? dashboardResult.data : FALLBACK_DASHBOARD);
      dashboard.statusPayload = statusResult.ok ? statusResult.data : null;
      dashboard.automationStatusPayload = automationResult.ok ? normalizeAutomationStatus(automationResult.data) : null;
      dashboard.loadMode = dashboardResult.ok ? 'live' : 'fallback';
      dashboard.loadError = dashboardResult.ok ? '' : dashboardResult.error;
      state.dashboard = dashboard;
      initializeSelection(dashboard);
      renderAll();
    } catch (error) {
      state.dashboard = parseDashboard(FALLBACK_DASHBOARD);
      state.dashboard.loadMode = 'fallback';
      state.dashboard.loadError = error instanceof Error ? error.message : String(error);
      initializeSelection(state.dashboard);
      renderAll();
    }
    if (target && state.dashboard?.loadError) {
      target.innerHTML = `<span class="error-text">공개 JSON fallback 표시 중: ${escapeHtml(state.dashboard.loadError)}</span>`;
    }
  }

  async function getJsonBestEffort(url, timeoutMs = 8500) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ok: true, data: await response.json(), url };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), url };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function parseDashboard(payload) {
    const etfs = asRecords(payload?.etfs).map((etf) => {
      const history = asRecords(etf.history).map(normalizeSnapshot).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
      const latest = normalizeSnapshot(etf.latest) || history.at(-1) || null;
      const signals = asRecords(etf.signals).map(normalizeSignal);
      return {
        id: stringOr(etf.id, ''),
        name: stringOr(etf.name, 'ETF'),
        shortName: stringOr(etf.shortName, etf.name, 'ETF'),
        code: stringOr(etf.code, ''),
        provider: stringOr(etf.provider, ''),
        sourceUrl: stringOr(etf.sourceUrl, '#'),
        listingDate: stringOr(etf.listingDate, ''),
        availableStartDate: stringOr(etf.availableStartDate, history[0]?.date, ''),
        availableEndDate: stringOr(etf.availableEndDate, history.at(-1)?.date, ''),
        historyCount: numberOr(etf.historyCount, history.length),
        latest,
        history,
        signals,
        metrics: isRecord(etf.metrics) ? etf.metrics : {},
      };
    });
    return {
      schemaVersion: stringOr(payload?.schemaVersion, ''),
      generatedAt: stringOr(payload?.generatedAt, ''),
      disclaimer: stringOr(payload?.disclaimer, ''),
      sourcePolicy: isRecord(payload?.sourcePolicy) ? payload.sourcePolicy : {},
      updatePolicy: isRecord(payload?.updatePolicy) ? payload.updatePolicy : {},
      historyPolicy: isRecord(payload?.historyPolicy) ? payload.historyPolicy : {},
      manualUpdatePolicy: isRecord(payload?.manualUpdatePolicy) ? payload.manualUpdatePolicy : {},
      etfs,
      signals: asRecords(payload?.signals).map(normalizeSignal),
    };
  }

  function normalizeSnapshot(snapshot) {
    if (!isRecord(snapshot)) return null;
    return {
      date: stringOr(snapshot.date, snapshot.asOfDate, ''),
      queryDate: stringOr(snapshot.queryDate, ''),
      navAsOfDate: stringOr(snapshot.navAsOfDate, ''),
      priceBasisDate: stringOr(snapshot.priceBasisDate, ''),
      sourceStatus: stringOr(snapshot.sourceStatus, ''),
      sourceConfidence: stringOr(snapshot.sourceConfidence, ''),
      sourceWarning: stringOr(snapshot.sourceWarning, ''),
      totalHoldings: numberOr(snapshot.totalHoldings, 0),
      fetchedAt: stringOr(snapshot.fetchedAt, ''),
      holdings: asRecords(snapshot.holdings).map(normalizeHolding),
      top10: asRecords(snapshot.top10).map(normalizeHolding),
      decomposition: asRecords(snapshot.decomposition).map(normalizeDecomposition),
      signals: asRecords(snapshot.signals).map(normalizeSignal),
      analysisSummary: isRecord(snapshot.analysisSummary) ? snapshot.analysisSummary : {},
    };
  }

  function normalizeHolding(row) {
    return {
      rank: numberOr(row.rank, 0),
      codeRaw: stringOr(row.codeRaw, ''),
      ticker: stringOr(row.ticker, ''),
      name: stringOr(row.name, ''),
      shares: finiteOrNull(row.shares),
      marketValueKrw: finiteOrNull(row.marketValueKrw),
      weightPercent: finiteOrNull(row.weightPercent),
      weight: finiteOrNull(row.weight),
      hasExternalTicker: Boolean(row.hasExternalTicker || row.ticker),
      hasProviderValuation: Boolean(row.hasProviderValuation),
      priceTrackingMethod: stringOr(row.priceTrackingMethod, ''),
      isPriceTracked: Boolean(row.isPriceTracked),
    };
  }

  function normalizeDecomposition(row) {
    return {
      date: stringOr(row.date, ''),
      previousDate: stringOr(row.previousDate, ''),
      previousPriceBasisDate: stringOr(row.previousPriceBasisDate, ''),
      currentPriceBasisDate: stringOr(row.currentPriceBasisDate, ''),
      priceReturnStartDate: stringOr(row.priceReturnStartDate, ''),
      priceReturnEndDate: stringOr(row.priceReturnEndDate, ''),
      name: stringOr(row.name, ''),
      codeRaw: stringOr(row.codeRaw, ''),
      ticker: stringOr(row.ticker, ''),
      rank: finiteOrNull(row.rank),
      previousRank: finiteOrNull(row.previousRank),
      actualWeightPercent: finiteOrNull(row.actualWeightPercent),
      previousWeightPercent: finiteOrNull(row.previousWeightPercent),
      securityReturn: finiteOrNull(row.securityReturn),
      benchmarkReturn: finiteOrNull(row.benchmarkReturn),
      predictedWeightPercent: finiteOrNull(row.predictedWeightPercent),
      deltaActualPercentPoint: finiteOrNull(row.deltaActualPercentPoint),
      deltaPricePercentPoint: finiteOrNull(row.deltaPricePercentPoint),
      deltaResidualPercentPoint: finiteOrNull(row.deltaResidualPercentPoint),
      membershipChange: stringOr(row.membershipChange, ''),
      positionStatus: stringOr(row.positionStatus, ''),
      holdingLifecycle: stringOr(row.holdingLifecycle, row.positionStatus, ''),
      currentIsTop10: Boolean(row.currentIsTop10),
      previousWasTop10: Boolean(row.previousWasTop10),
      displayScope: stringOr(row.displayScope, ''),
      displayOrder: numberOr(row.displayOrder, 999),
      priceSource: stringOr(row.priceSource, ''),
      priceSourceType: stringOr(row.priceSourceType, ''),
      attributionFormula: stringOr(row.attributionFormula, ''),
      classification: stringOr(row.classification, 'insufficient_data'),
      economicSignal: stringOr(row.economicSignal, row.classification, 'insufficient_data'),
      confidence: stringOr(row.confidence, ''),
      message: stringOr(row.message, ''),
    };
  }

  function normalizeSignal(signal) {
    return {
      etfId: stringOr(signal.etfId, ''),
      etfName: stringOr(signal.etfName, ''),
      date: stringOr(signal.date, ''),
      previousDate: stringOr(signal.previousDate, ''),
      type: stringOr(signal.type, ''),
      severity: stringOr(signal.severity, ''),
      name: stringOr(signal.name, ''),
      codeRaw: stringOr(signal.codeRaw, ''),
      ticker: stringOr(signal.ticker, ''),
      rank: finiteOrNull(signal.rank),
      previousRank: finiteOrNull(signal.previousRank),
      weightPercent: finiteOrNull(signal.weightPercent),
      previousWeightPercent: finiteOrNull(signal.previousWeightPercent),
      message: stringOr(signal.message, ''),
    };
  }

  function normalizeAutomationStatus(payload) {
    if (!isRecord(payload)) return null;
    return {
      generatedAt: stringOr(payload.generatedAt, ''),
      targetDate: stringOr(payload.targetDate, ''),
      runStatus: stringOr(payload.runStatus, 'unknown'),
      overallStatus: stringOr(payload.overallStatus, ''),
      warningCount: numberOr(payload.warningCount, 0),
      warnings: asArray(payload.warnings).map((item) => stringOr(item, '')).filter(Boolean),
    };
  }

  function wireControls() {
    $('#etf-select')?.addEventListener('change', (event) => {
      state.selectedEtfId = event.target.value;
      syncDateInputsForSelected(false);
      renderSelectedEtf();
    });
    $('#start-date')?.addEventListener('change', (event) => {
      state.startDate = event.target.value;
      renderSelectedEtf();
    });
    $('#end-date')?.addEventListener('change', (event) => {
      state.endDate = event.target.value;
      renderSelectedEtf();
    });
    $('#reset-range')?.addEventListener('click', () => {
      syncDateInputsForSelected(true);
      renderSelectedEtf();
    });
    $('#copy-update-command')?.addEventListener('click', () => {
      copyManualUpdateCommand();
    });
  }

  function initializeSelection(dashboard) {
    const first = dashboard.etfs[0];
    state.selectedEtfId = state.selectedEtfId || first?.id || '';
    syncEtfSelect(dashboard);
    syncDateInputsForSelected(true);
  }

  function syncEtfSelect(dashboard) {
    const select = $('#etf-select');
    if (!select) return;
    select.replaceChildren(...dashboard.etfs.map((etf) => {
      const option = document.createElement('option');
      option.value = etf.id;
      option.textContent = `${etf.shortName} (${etf.code})`;
      option.selected = etf.id === state.selectedEtfId;
      return option;
    }));
  }

  function syncDateInputsForSelected(forceAll) {
    const etf = selectedEtf();
    if (!etf) return;
    const dates = etf.history.map((row) => row.date).filter(Boolean);
    const first = dates[0] || '';
    const last = dates.at(-1) || '';
    if (forceAll || !state.startDate || state.startDate < first || state.startDate > last) state.startDate = first;
    if (forceAll || !state.endDate || state.endDate > last || state.endDate < first) state.endDate = last;
    const start = $('#start-date');
    const end = $('#end-date');
    if (start) {
      start.min = first;
      start.max = last;
      start.value = state.startDate;
    }
    if (end) {
      end.min = first;
      end.max = last;
      end.value = state.endDate;
    }
  }

  function renderAll() {
    renderOverview();
    renderManualUpdate();
    renderSelectedEtf();
    renderSignals();
  }

  function renderOverview() {
    const dashboard = state.dashboard;
    if (!dashboard) return;
    const latestDates = dashboard.etfs.map((etf) => etf.latest?.date).filter(Boolean).sort();
    const historyStarts = dashboard.etfs.map((etf) => etf.availableStartDate).filter(Boolean).sort();
    const sourceWarnings = dashboard.etfs.filter((etf) => etf.latest?.sourceStatus && etf.latest.sourceStatus !== 'live').length;
    const totalSignals = dashboard.etfs.reduce((sum, etf) => sum + asArray(etf.latest?.signals).length, 0);
    renderMetricCards('#overview-metrics', [
      ['추적 ETF', `${dashboard.etfs.length}개`],
      ['히스토리 시작', formatMaybeDate(historyStarts[0] || dashboard.historyPolicy?.availableStartDate)],
      ['최근 기준일', formatMaybeDate(latestDates.at(-1))],
      ['최근 특별 신호', `${totalSignals.toLocaleString('ko-KR')}건`],
      ['소스 경고', sourceWarnings ? `${sourceWarnings}개 ETF 확인 필요` : '정상'],
    ]);
    const status = $('#data-status');
    if (status) {
      const mode = dashboard.loadMode === 'fallback' ? 'fallback 표시 중' : '공개 JSON 로드 완료';
      status.textContent = `${mode} · 생성 ${formatFreshness(dashboard.generatedAt)} · 자동화 ${formatAutomationStatus(dashboard.automationStatusPayload)} · ${dashboard.disclaimer || '투자 조언이 아닙니다.'}`;
    }
  }

  function renderManualUpdate() {
    const policy = state.dashboard?.manualUpdatePolicy || {};
    const workflowUrl = stringOr(policy.workflowUrl, WORKFLOW_URL);
    const command = stringOr(policy.cliCommand, MANUAL_UPDATE_COMMAND);
    const manualLink = $('#manual-update-link');
    const workflowLink = $('#workflow-status-link');
    const commandTarget = $('#manual-update-command');
    const status = $('#manual-update-status');
    if (manualLink) manualLink.href = workflowUrl;
    if (workflowLink) workflowLink.href = workflowUrl;
    if (commandTarget) commandTarget.textContent = command;
    if (status) {
      const mode = policy.defaultMode === 'missing_only' ? 'missing-only' : stringOr(policy.defaultMode, 'missing-only');
      status.textContent = `기본값은 ${mode}입니다. 이미 저장된 날짜는 건너뛰고, 필요할 때만 refresh_existing=true로 재수집하세요.`;
    }
  }

  async function copyManualUpdateCommand() {
    const command = $('#manual-update-command')?.textContent || MANUAL_UPDATE_COMMAND;
    const status = $('#manual-update-status');
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      if (status) status.textContent = 'CLI 실행 명령을 복사했습니다. 터미널에서 실행하면 같은 수동 워크플로를 시작합니다.';
    } catch {
      if (status) status.textContent = '브라우저가 자동 복사를 허용하지 않습니다. 아래 CLI 명령을 직접 선택해 복사하세요.';
    }
  }

  function selectedEtf() {
    return state.dashboard?.etfs.find((etf) => etf.id === state.selectedEtfId) || state.dashboard?.etfs[0] || null;
  }

  function renderSelectedEtf() {
    const etf = selectedEtf();
    if (!etf) return;
    const filtered = filterHistory(etf.history, state.startDate, state.endDate);
    const latest = filtered.at(-1) || etf.latest;
    renderWeightChart('#weight-chart', filtered, latest?.top10 || []);
    renderTop10(etf, latest);
    renderDecomposition(latest);
    renderSource(etf, latest, filtered);
    const provider = $('#provider-link');
    if (provider) provider.href = etf.sourceUrl || '#';
  }

  function filterHistory(history, startDate, endDate) {
    return asArray(history).filter((row) => (!startDate || row.date >= startDate) && (!endDate || row.date <= endDate));
  }

  function renderWeightChart(selector, history, latestTop10) {
    const target = $(selector);
    if (!target) return;
    const series = buildWeightSeries(history, latestTop10);
    if (!series.length) {
      target.innerHTML = '<div class="skeleton-line">아직 표시할 히스토리가 없습니다. 다음 업데이트 후 누적됩니다.</div>';
      return;
    }
    const points = series.flatMap((item) => item.points);
    const dates = points.map((point) => Date.parse(point.date)).filter(Number.isFinite);
    const values = points.map((point) => point.value).filter(Number.isFinite);
    const width = 960;
    const height = 420;
    const margin = { top: 30, right: 32, bottom: 82, left: 76 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const yTicks = buildNiceTicks(0, Math.max(...values, 1) * 1.08, 6);
    const yMin = yTicks[0] ?? 0;
    const yMax = yTicks.at(-1) ?? Math.max(...values, 1);
    const xTicks = buildDateTicks(points.map((point) => point.date).filter(Boolean), 14);
    const xTickYears = new Set(xTicks.map((date) => date.slice(0, 4)));
    const showYearOnTicks = xTickYears.size > 1;
    const colorByKey = buildSeriesColorMap(series);
    const x = (date) => margin.left + ((Date.parse(date) - minDate) / Math.max(maxDate - minDate, 1)) * innerWidth;
    const y = (value) => margin.top + (1 - (value - yMin) / Math.max(yMax - yMin, 1)) * innerHeight;
    const yGrid = yTicks.map((tick) => `<g class="axis-row"><line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="#d9e2f1"/><text x="${margin.left - 14}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${formatAxisWeight(tick)}</text></g>`).join('');
    const xGrid = xTicks.map((tick) => {
      const xPos = x(tick);
      return `<g class="axis-column"><line x1="${xPos.toFixed(1)}" x2="${xPos.toFixed(1)}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#e7edf7"/><text x="${xPos.toFixed(1)}" y="${height - margin.bottom + 24}" text-anchor="middle">${escapeHtml(formatAxisDate(tick, showYearOnTicks))}</text></g>`;
    }).join('');
    const paths = series.map((item, index) => {
      const color = colorByKey.get(item.key) || CHART_COLORS[index % CHART_COLORS.length];
      const valid = item.points.filter((point) => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.date)));
      const path = valid.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${x(point.date).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
      const circles = valid.map((point) => `<circle cx="${x(point.date).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="3.4" fill="${color}"><title>${escapeHtml(item.label)} ${point.date}: ${formatWeight(point.value)}</title></circle>`).join('');
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${circles}`;
    }).join('');
    const legend = series.map((item, index) => {
      const color = colorByKey.get(item.key) || CHART_COLORS[index % CHART_COLORS.length];
      return `<span><i class="legend-key" style="background:${color}"></i>${escapeHtml(item.label)}</span>`;
    }).join('');
    const firstDate = new Date(minDate).toISOString().slice(0, 10);
    const lastDate = new Date(maxDate).toISOString().slice(0, 10);
    target.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>
        ${yGrid}
        ${xGrid}
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="#aab7cf"/>
        <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#aab7cf"/>
        <text class="axis-title" x="${margin.left}" y="20">TOP10 비중(%)</text>
        <text class="axis-range" x="${margin.left + innerWidth / 2}" y="${height - 22}" text-anchor="middle">기간 ${escapeHtml(firstDate)} → ${escapeHtml(lastDate)}</text>
        ${paths}
      </svg>
      <div class="chart-legend">${legend}</div>
    `;
  }

  function buildWeightSeries(history, latestTop10) {
    const keys = latestTop10.map((row) => holdingKey(row)).filter(Boolean).slice(0, 10);
    return keys.map((key) => {
      const latest = latestTop10.find((row) => holdingKey(row) === key) || {};
      const label = latest.ticker || latest.name || key;
      const points = history.map((snapshot) => {
        const hasFullHoldings = Boolean(snapshot.holdings?.length);
        const universe = hasFullHoldings ? snapshot.holdings : snapshot.top10;
        const holding = universe.find((row) => holdingKey(row) === key);
        return { date: snapshot.date, value: holding?.weightPercent ?? null };
      });
      return { key, label, points };
    }).filter((item) => item.points.some((point) => point.value > 0));
  }

  function buildSeriesColorMap(series) {
    const colorMap = new Map();
    asArray(series).forEach((item, orderIndex) => {
      const color = CHART_COLORS[orderIndex] || `hsl(${Math.round((orderIndex * 137.508) % 360)} 78% 38%)`;
      colorMap.set(item.key, color);
    });
    return colorMap;
  }

  function holdingKey(row) {
    return stringOr(row?.ticker, row?.codeRaw, row?.name, '').toUpperCase();
  }

  function renderTop10(etf, latest) {
    const rows = latest?.top10 || [];
    const decomposition = new Map((latest?.decomposition || []).map((row) => [holdingKey(row), row]));
    renderRows('#top10-rows', rows, (holding) => {
      const decomp = decomposition.get(holdingKey(holding)) || {};
      return [
        holding.rank,
        nameCell(holding.name, holding.codeRaw),
        priceIdentifierCell(holding, decomp),
        formatWeight(holding.weightPercent),
        formatWeight(decomp.previousWeightPercent),
        formatPercentPoint(decomp.deltaPricePercentPoint),
        formatPercentPoint(decomp.deltaResidualPercentPoint),
        attributionBadges(decomp),
      ];
    }, 8);
  }

  function renderDecomposition(latest) {
    const rows = sortAttributionRows(latest?.decomposition || []);
    renderRows('#decomposition-rows', rows, (row) => [
      scopeLabel(row),
      nameCell(row.name, row.ticker),
      `${formatWeight(row.previousWeightPercent)} → ${formatWeight(row.actualWeightPercent)}`,
      formatReturn(row.securityReturn),
      formatPercentPoint(row.deltaPricePercentPoint),
      formatPercentPoint(row.deltaResidualPercentPoint),
      basisCell(row),
      attributionBadges(row),
    ], 8);
  }

  function renderSource(etf, latest, filteredHistory) {
    const target = $('#source-list');
    if (!target) return;
    const summary = latest?.analysisSummary || {};
    const priceBasis = summary.priceBasis || {};
    const dateBasis = summary.dateBasis || {};
    const historyPolicy = state.dashboard?.historyPolicy || {};
    const selectedStart = filteredHistory[0]?.date || etf.availableStartDate;
    const selectedEnd = filteredHistory.at(-1)?.date || etf.availableEndDate;
    target.innerHTML = `
      <div class="source-item"><strong>${escapeHtml(etf.name)}</strong><span>${escapeHtml(etf.provider)} · ${escapeHtml(etf.code)}</span></div>
      <div class="source-item"><strong>기준일</strong><span>${escapeHtml(formatMaybeDate(latest?.date))} · 선택 범위 ${filteredHistory.length.toLocaleString('ko-KR')}개 스냅샷</span></div>
      <div class="source-item"><strong>히스토리 범위</strong><span>선택 ${escapeHtml(formatMaybeDate(selectedStart))} → ${escapeHtml(formatMaybeDate(selectedEnd))} · 저장 전체 ${escapeHtml(formatMaybeDate(etf.availableStartDate))} → ${escapeHtml(formatMaybeDate(etf.availableEndDate))}</span><small>${escapeHtml(historyPolicy.startDateExplanation || '예약 업데이트는 최근 구간을 갱신하고, 수동 백필로 더 과거 구간을 확장할 수 있습니다.')}</small></div>
      <div class="source-item"><strong>전일대비 분해 기준</strong><span>ETF 비중 ${escapeHtml(formatMaybeDate(dateBasis.previousSnapshotDate))} → ${escapeHtml(formatMaybeDate(dateBasis.currentSnapshotDate || latest?.date))} · 가격 기준 ${escapeHtml(formatMaybeDate(priceBasis.previous))} → ${escapeHtml(formatMaybeDate(priceBasis.current || latest?.priceBasisDate))}</span></div>
      <div class="source-item"><strong>소스 상태</strong><span class="${latest?.sourceStatus === 'live' ? '' : 'warning'}">${escapeHtml(latest?.sourceStatus || 'unknown')} · ${escapeHtml(latest?.sourceWarning || '정상')}</span></div>
      <div class="source-item"><strong>수익률 커버리지</strong><span>${formatCoverage(summary.returnCoverage)} · ${escapeHtml(summary.returnCoverageStatus || 'insufficient')}</span></div>
    `;
    const pill = $('#coverage-pill');
    if (pill) {
      const warning = summary.returnCoverageStatus && summary.returnCoverageStatus !== 'ok';
      pill.classList.toggle('warning', Boolean(warning));
      pill.textContent = `수익률 커버리지 ${formatCoverage(summary.returnCoverage)}`;
    }
  }

  function renderSignals() {
    const target = $('#signal-grid');
    if (!target || !state.dashboard) return;
    const selected = selectedEtf();
    const selectedSignals = asArray(selected?.latest?.signals).map((signal) => ({ ...signal, etfName: selected?.shortName || selected?.name || '' }));
    const globalSignals = state.dashboard.signals.length ? state.dashboard.signals : selectedSignals;
    const signals = (selectedSignals.length ? selectedSignals : globalSignals).slice(0, 9);
    if (!signals.length) {
      target.innerHTML = '<div class="skeleton-line">아직 특별 신호가 없습니다. 최초 스냅샷 이후 다음 업데이트부터 편입·편출과 잔차가 표시됩니다.</div>';
      return;
    }
    target.replaceChildren(...signals.map((signal) => {
      const article = document.createElement('article');
      article.className = `signal-card ${escapeAttribute(signal.severity || '')}`;
      article.innerHTML = `
        ${classificationBadge(signal.type || 'signal').outerHTML}
        <strong>${escapeHtml(signal.etfName || '')} ${escapeHtml(signal.name || signal.ticker || '신호')}</strong>
        <p>${escapeHtml(formatMaybeDate(signal.date))} · ${escapeHtml(signal.message || signal.type)} · ${formatWeight(signal.previousWeightPercent)} → ${formatWeight(signal.weightPercent)}</p>
      `;
      return article;
    }));
  }

  function renderMetricCards(selector, entries) {
    const target = $(selector);
    if (!target) return;
    target.replaceChildren(...entries.map(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'metric-card';
      card.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong>`;
      return card;
    }));
  }

  function renderRows(selector, rows, mapper, colspan) {
    const target = $(selector);
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = `<tr><td colspan="${colspan}">표시할 데이터가 없습니다.</td></tr>`;
      return;
    }
    target.replaceChildren(...rows.map((row) => {
      const tr = document.createElement('tr');
      mapper(row).forEach((value) => {
        const td = document.createElement('td');
        if (isDomNode(value)) td.appendChild(value);
        else td.textContent = value === null || value === undefined || value === '' ? '-' : String(value);
        tr.appendChild(td);
      });
      return tr;
    }));
  }

  function nameCell(name, subtext) {
    const div = document.createElement('div');
    div.className = 'name-cell';
    div.innerHTML = `<strong>${escapeHtml(name || '-')}</strong><span>${escapeHtml(subtext || '')}</span>`;
    return div;
  }

  function badge(text) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = text || '-';
    return span;
  }


  function priceIdentifierCell(holding, decomp) {
    if (holding?.ticker) return badge(holding.ticker);
    if (decomp?.priceSource === 'provider_valuation_krw' || holding?.priceTrackingMethod === 'provider_valuation_krw') return badge('KRW 평가단가');
    if (holding?.isPriceTracked) return badge('가격 추적');
    return '티커 없음';
  }

  function classificationBadge(value) {
    const span = document.createElement('span');
    const key = stringOr(value, 'insufficient_data');
    span.className = `classification ${escapeAttribute(key)}`;
    span.textContent = classLabel(key);
    return span;
  }

  function attributionBadges(row) {
    const div = document.createElement('div');
    div.className = 'badge-stack';
    const membership = stringOr(row?.membershipChange, '');
    const classification = stringOr(row?.classification, 'insufficient_data');
    if (membership) div.appendChild(classificationBadge(membership));
    if (!membership || membership !== classification) div.appendChild(classificationBadge(classification));
    if (row?.confidence) {
      const confidence = document.createElement('span');
      confidence.className = 'confidence-text';
      confidence.textContent = row.confidence;
      div.appendChild(confidence);
    }
    return div;
  }

  function sortAttributionRows(rows) {
    const scopeRank = { current_top10: 0, previous_top10_exit: 1, tracked_holding: 2 };
    return asRecords(rows).slice().sort((a, b) => (
      (scopeRank[a.displayScope] ?? 9) - (scopeRank[b.displayScope] ?? 9)
      || numberOr(a.displayOrder, 999) - numberOr(b.displayOrder, 999)
      || numberOr(a.rank, 999) - numberOr(b.rank, 999)
      || stringOr(a.name).localeCompare(stringOr(b.name), 'ko')
    ));
  }

  function scopeLabel(row) {
    if (row?.currentIsTop10) return '현재 TOP10';
    if (row?.previousWasTop10) return '전일 TOP10';
    return '추적';
  }

  function basisCell(row) {
    const div = document.createElement('div');
    div.className = 'basis-cell';
    const closeStart = row.priceReturnStartDate || row.previousPriceBasisDate;
    const closeEnd = row.priceReturnEndDate || row.currentPriceBasisDate;
    div.innerHTML = `
      <strong>${escapeHtml(formatMaybeDate(closeStart))} → ${escapeHtml(formatMaybeDate(closeEnd))}</strong>
      <span>${escapeHtml(formatPriceSource(row.priceSource || row.priceSourceType))}</span>
    `;
    return div;
  }

  function classLabel(value) {
    const labels = {
      price_explained: '가격 설명',
      likely_buy: '잔차+ 매수 가능성',
      likely_sell: '잔차- 매도 가능성',
      mixed: '혼합/저신뢰',
      new_entry: '신규 보유',
      top10_entry: 'TOP10 편입',
      exit: 'TOP10 편출',
      top10_exit: 'TOP10 편출',
      fund_exit: '보유 제외',
      insufficient_data: '데이터 부족',
      signal: '신호',
    };
    return labels[value] || value;
  }

  function buildNiceTicks(min, max, preferredCount = 6) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || preferredCount < 2) return [];
    const safeMin = Math.min(min, max);
    let safeMax = Math.max(min, max);
    if (safeMin === safeMax) safeMax = safeMin + 1;
    const range = safeMax - safeMin;
    const step = niceNumber(range / Math.max(preferredCount - 1, 1), true);
    const start = Math.floor(safeMin / step) * step;
    const end = Math.ceil(safeMax / step) * step;
    const ticks = [];
    for (let value = start; value <= end + step / 2; value += step) {
      ticks.push(roundAxisValue(value));
    }
    return ticks;
  }

  function niceNumber(range, round) {
    if (!Number.isFinite(range) || range <= 0) return 1;
    const exponent = Math.floor(Math.log10(range));
    const fraction = range / (10 ** exponent);
    const niceFraction = round
      ? (fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10)
      : (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10);
    return niceFraction * (10 ** exponent);
  }

  function roundAxisValue(value) {
    return Number(value.toFixed(8));
  }

  function buildDateTicks(dates, maxTicks = 14) {
    const unique = Array.from(new Set(asArray(dates).filter((date) => Number.isFinite(Date.parse(date))))).sort();
    if (unique.length <= maxTicks) return unique;
    const first = unique[0];
    const last = unique.at(-1);
    const weeklyMondays = unique.filter(isUtcMonday);
    const ruleTicks = uniqueDateTicks([first, ...weeklyMondays, last]);
    if (weeklyMondays.length && ruleTicks.length <= maxTicks) return ruleTicks;
    if (weeklyMondays.length) return downsampleDateTicks(ruleTicks, maxTicks);
    return downsampleDateTicks(unique, maxTicks);
  }

  function downsampleDateTicks(dates, maxTicks) {
    const unique = uniqueDateTicks(dates);
    const ticks = [];
    for (let index = 0; index < maxTicks; index += 1) {
      const date = unique[Math.round(index * (unique.length - 1) / (maxTicks - 1))];
      if (date && ticks.at(-1) !== date) ticks.push(date);
    }
    if (ticks.at(-1) !== unique.at(-1)) ticks.push(unique.at(-1));
    return ticks;
  }

  function uniqueDateTicks(dates) {
    return Array.from(new Set(asArray(dates).filter(Boolean))).sort();
  }

  function isUtcMonday(date) {
    const time = Date.parse(date);
    return Number.isFinite(time) && new Date(time).getUTCDay() === 1;
  }

  function formatAxisWeight(value) {
    const num = finiteOrNull(value);
    if (num === null) return '-';
    const isInteger = Math.abs(num - Math.round(num)) < 0.000001;
    return `${num.toLocaleString('ko-KR', { maximumFractionDigits: isInteger ? 0 : 1, minimumFractionDigits: 0 })}%`;
  }

  function formatAxisDate(value, showYear = false) {
    const text = formatMaybeDate(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return text;
    const [, year, month, day] = match;
    return showYear ? `${year.slice(2)}.${month}.${day}` : `${month}.${day}`;
  }

  function formatWeight(value) {
    const num = finiteOrNull(value);
    if (num === null) return '-';
    return `${num.toLocaleString('ko-KR', { maximumFractionDigits: 2, minimumFractionDigits: 0 })}%`;
  }

  function formatPercentPoint(value) {
    const num = finiteOrNull(value);
    if (num === null) return '-';
    const sign = num > 0 ? '+' : '';
    return `${sign}${num.toLocaleString('ko-KR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}pp`;
  }

  function formatReturn(value) {
    const num = finiteOrNull(value);
    if (num === null) return '-';
    const sign = num > 0 ? '+' : '';
    return `${sign}${(num * 100).toLocaleString('ko-KR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
  }

  function formatPriceSource(value) {
    const labels = {
      provider_valuation_krw: 'ETF KRW 평가단가',
      etf_provider_unit_value_krw: 'ETF KRW 평가단가',
      yahoo_chart_query1: 'Yahoo Chart',
      yahoo_chart_query2: 'Yahoo Chart 보조',
      stooq_csv: 'Stooq CSV',
      finance_datareader: 'FinanceDataReader',
    };
    const key = stringOr(value, '');
    return labels[key] || key || '가격 소스 없음';
  }

  function formatCoverage(value) {
    const num = finiteOrNull(value);
    if (num === null) return '-';
    return `${(num * 100).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}%`;
  }

  function formatAutomationStatus(value) {
    if (!value) return '상태 파일 없음';
    const labels = {
      ok: '정상',
      waiting_for_data: '데이터 대기',
      degraded: '주의',
      soft_failed: '소프트 실패 기록',
      missing_status: '상태 누락',
      unreadable_status: '상태 파싱 실패',
    };
    const base = labels[value.runStatus] || value.runStatus || 'unknown';
    return value.warningCount ? `${base} · 경고 ${value.warningCount}건` : base;
  }

  function formatFreshness(value) {
    if (!value) return '업데이트 시각 알 수 없음';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `${date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} KST`;
  }

  function formatMaybeDate(value) {
    if (!value) return '-';
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
  }

  function asArray(value) { return Array.isArray(value) ? value : []; }
  function asRecords(value) { return asArray(value).filter(isRecord); }
  function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function finiteOrNull(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  function numberOr(value, fallback) {
    const num = finiteOrNull(value);
    return num === null ? fallback : num;
  }
  function stringOr(...values) {
    for (const value of values) {
      if (value !== null && value !== undefined && String(value).trim() !== '') return String(value);
    }
    return '';
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function escapeAttribute(value) { return escapeHtml(value); }
  function isDomNode(value) { return typeof Node !== 'undefined' && value instanceof Node; }

  if (typeof globalThis !== 'undefined') {
    globalThis.__ETF_TRACKING_TESTS__ = {
      parseDashboard,
      normalizeSnapshot,
      normalizeHolding,
      normalizeDecomposition,
      normalizeSignal,
      normalizeAutomationStatus,
      filterHistory,
      buildWeightSeries,
      buildSeriesColorMap,
      buildNiceTicks,
      buildDateTicks,
      formatAxisWeight,
      formatAxisDate,
      sortAttributionRows,
      priceIdentifierCell,
      holdingKey,
      classLabel,
      formatWeight,
      formatReturn,
      formatPriceSource,
      formatCoverage,
      formatAutomationStatus,
      FALLBACK_DASHBOARD,
      AUTOMATION_STATUS_URL,
      QUANT_DASHBOARD_URL,
      WORKFLOW_URL,
      MANUAL_UPDATE_COMMAND,
    };
  }
})();
