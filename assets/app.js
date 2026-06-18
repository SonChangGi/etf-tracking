(() => {
  'use strict';

  const DATA_URL = 'data/dashboard.json';
  const STATUS_URL = 'data/status.json';
  const AUTOMATION_STATUS_URL = 'data/automation-status.json';
  const QUANT_DASHBOARD_URL = 'https://sonchanggi.github.io/quant-dashboard/';
  const WORKFLOW_URL = 'https://github.com/SonChangGi/etf-tracking/actions/workflows/update-data.yml';
  const MANUAL_UPDATE_COMMAND = 'gh workflow run update-data.yml --repo SonChangGi/etf-tracking --ref main -f backfill_all=false -f backfill_start_date= -f refresh_existing=false -f strict_validation=false';
  const SUPPORTED_SCHEMA_MAJOR = 1;
  const ALLOWED_LINK_HOSTS = new Set(['github.com', 'sonchanggi.github.io', 'timeetf.co.kr', 'www.samsungactive.co.kr', 'samsungactive.co.kr']);
  const CHART_COLORS = [
    '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed',
    '#0891b2', '#db2777', '#4d7c0f', '#92400e', '#111827',
    '#0f766e', '#be123c', '#4338ca', '#0369a1', '#a16207',
    '#15803d', '#c2410c', '#7f1d1d', '#581c87', '#0e7490',
  ];
  const SIGNAL_TABLE_INITIAL_LIMIT = 30;
  const SIGNAL_TABLE_LOAD_STEP = 30;
  const SIGNAL_TABLE_WEIGHT_THRESHOLD = 0.25;
  const SIGNAL_TABLE_RESIDUAL_THRESHOLD = 0.1;
  const SIGNAL_TABLE_DEFAULT_FILTER = Object.freeze({
    bucket: 'signal',
    query: '',
    rankScope: 'all',
    magnitude: 'all',
    sort: 'recent',
    limit: SIGNAL_TABLE_INITIAL_LIMIT,
  });
  const $ = (selector) => (typeof document === 'undefined' ? null : document.querySelector(selector));

  const state = {
    dashboard: null,
    selectedEtfId: null,
    startDate: '',
    endDate: '',
    signalTableFilters: {},
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
      schemaWarning: schemaWarning(payload?.schemaVersion),
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
      currency: stringOr(row.currency, ''),
      fxApplied: row.fxApplied === null || row.fxApplied === undefined ? null : Boolean(row.fxApplied),
      fxPair: stringOr(row.fxPair, ''),
      fxReturn: finiteOrNull(row.fxReturn),
      localCurrencyReturn: finiteOrNull(row.localCurrencyReturn),
      attributionFormula: stringOr(row.attributionFormula, ''),
      classification: stringOr(row.classification, 'insufficient_data'),
      economicSignal: stringOr(row.economicSignal, row.classification, 'insufficient_data'),
      actionEstimate: stringOr(row.actionEstimate, ''),
      actionLabel: stringOr(row.actionLabel, ''),
      actionExplanation: stringOr(row.actionExplanation, ''),
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
      actionEstimate: stringOr(signal.actionEstimate, ''),
      actionLabel: stringOr(signal.actionLabel, ''),
      actionExplanation: stringOr(signal.actionExplanation, ''),
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
      handleEtfSelectionChange(event.target.value);
    });
    $('#start-date')?.addEventListener('change', (event) => {
      handleDateRangeChange('startDate', event.target.value);
    });
    $('#end-date')?.addEventListener('change', (event) => {
      handleDateRangeChange('endDate', event.target.value);
    });
    $('#reset-range')?.addEventListener('click', () => {
      handleDateRangeReset();
    });
    $('#copy-update-command')?.addEventListener('click', () => {
      copyManualUpdateCommand();
    });
    const signalTables = $('#etf-signal-tables');
    signalTables?.addEventListener('input', handleSignalTableControlInput);
    signalTables?.addEventListener('change', handleSignalTableControlChange);
    signalTables?.addEventListener('click', handleSignalTableControlClick);
  }

  function handleEtfSelectionChange(etfId) {
    state.selectedEtfId = stringOr(etfId, state.selectedEtfId, '');
    syncDateInputsForSelected(false);
    renderSelectionDependentViews();
  }

  function handleDateRangeChange(field, value) {
    if (field !== 'startDate' && field !== 'endDate') return;
    state[field] = stringOr(value, '');
    renderSelectionDependentViews();
  }

  function handleDateRangeReset() {
    syncDateInputsForSelected(true);
    renderSelectionDependentViews();
  }

  function handleSignalTableControlInput(event) {
    const control = event.target?.closest?.('[data-signal-filter]');
    if (!control || control.dataset.signalFilter !== 'query') return;
    const etfId = control.dataset.etfId;
    updateSignalTableFilter(etfId, { query: control.value }, true);
    restoreSignalTableFocus(etfId, 'query', control.selectionStart);
  }

  function handleSignalTableControlChange(event) {
    const control = event.target?.closest?.('[data-signal-filter]');
    if (!control || control.dataset.signalFilter === 'query') return;
    updateSignalTableFilter(control.dataset.etfId, { [control.dataset.signalFilter]: control.value });
  }

  function handleSignalTableControlClick(event) {
    const bucketButton = event.target?.closest?.('[data-signal-bucket]');
    if (bucketButton) {
      updateSignalTableFilter(bucketButton.dataset.etfId, { bucket: bucketButton.dataset.signalBucket });
      return;
    }
    const loadButton = event.target?.closest?.('[data-signal-load-more]');
    if (loadButton) {
      const filter = signalTableFilterFor(loadButton.dataset.etfId);
      updateSignalTableFilter(loadButton.dataset.etfId, { limit: filter.limit + SIGNAL_TABLE_LOAD_STEP }, false);
      return;
    }
    const showAllButton = event.target?.closest?.('[data-signal-show-all]');
    if (showAllButton) {
      updateSignalTableFilter(showAllButton.dataset.etfId, { limit: Number.MAX_SAFE_INTEGER }, false);
      return;
    }
    const resetButton = event.target?.closest?.('[data-signal-reset]');
    if (resetButton) resetSignalTableFilter(resetButton.dataset.etfId);
  }

  function signalTableDefaultFilter() {
    return { ...SIGNAL_TABLE_DEFAULT_FILTER };
  }

  function signalTableFilterFor(etfId) {
    const key = stringOr(etfId, 'default');
    if (!state.signalTableFilters[key]) state.signalTableFilters[key] = signalTableDefaultFilter();
    return state.signalTableFilters[key];
  }

  function updateSignalTableFilter(etfId, patch, resetLimit = true) {
    const key = stringOr(etfId, 'default');
    state.signalTableFilters[key] = normalizeSignalTableFilter({
      ...signalTableFilterFor(key),
      ...patch,
      limit: resetLimit ? SIGNAL_TABLE_INITIAL_LIMIT : finiteOrNull(patch?.limit) ?? signalTableFilterFor(key).limit,
    });
    renderSignalTables();
  }

  function resetSignalTableFilter(etfId) {
    state.signalTableFilters[stringOr(etfId, 'default')] = signalTableDefaultFilter();
    renderSignalTables();
  }

  function restoreSignalTableFocus(etfId, field, selectionStart) {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      const next = asArray(document.querySelectorAll('[data-signal-filter]'))
        .find((control) => control.dataset.etfId === etfId && control.dataset.signalFilter === field);
      if (!next) return;
      next.focus();
      if (typeof next.setSelectionRange === 'function') {
        const pos = finiteOrNull(selectionStart) ?? next.value.length;
        next.setSelectionRange(pos, pos);
      }
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
    renderSelectionDependentViews();
  }

  function renderSelectionDependentViews() {
    renderSelectedEtf();
    renderSignals();
    renderSignalTables();
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
      const schema = dashboard.schemaWarning ? ` · ${dashboard.schemaWarning}` : '';
      status.textContent = `${mode} · 생성 ${formatFreshness(dashboard.generatedAt)} · 자동화 ${formatAutomationStatus(dashboard.automationStatusPayload)}${schema} · ${dashboard.disclaimer || '투자 조언이 아닙니다.'}`;
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
    if (manualLink) manualLink.href = safeHttpUrl(workflowUrl, WORKFLOW_URL);
    if (workflowLink) workflowLink.href = safeHttpUrl(workflowUrl, WORKFLOW_URL);
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
    if (provider) provider.href = safeHttpUrl(etf.sourceUrl, '#');
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
    const width = 1080;
    const height = 460;
    const margin = { top: 42, right: 172, bottom: 92, left: 82 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const useZoomedAxis = minValue > 1 && (maxValue - minValue) < 8;
    const yDomainMin = useZoomedAxis ? Math.max(0, Math.floor((minValue - 0.45) * 2) / 2) : 0;
    const yDomainMax = useZoomedAxis ? Math.ceil((maxValue + 0.45) * 2) / 2 : Math.max(maxValue, 1) * 1.08;
    const yTicks = buildNiceTicks(yDomainMin, yDomainMax, useZoomedAxis ? 7 : 6);
    const yMin = yTicks[0] ?? 0;
    const yMax = yTicks.at(-1) ?? Math.max(...values, 1);
    const targetWidth = Number(target.clientWidth || width);
    const maxTicks = targetWidth < 520 ? 5 : targetWidth < 820 ? 8 : 12;
    const xTicks = buildDateTicks(points.map((point) => point.date).filter(Boolean), maxTicks, innerWidth);
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
      const widthByRank = item.rank && item.rank <= 3 ? 3.7 : 2.5;
      const dash = item.isSparse ? ' stroke-dasharray="7 5"' : '';
      const segments = splitPointSegments(item.points);
      const segmentPathData = segments.map((segment) => segment
        .map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${x(point.date).toFixed(1)} ${y(point.value).toFixed(1)}`)
        .join(' '));
      const hitPaths = segmentPathData.map((path) => `<path class="series-hit" d="${path}" fill="none" stroke="transparent" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
      const segmentPaths = segmentPathData.map((path) => `<path class="series-line" d="${path}" fill="none" stroke="${color}" stroke-width="${widthByRank}"${dash} stroke-linecap="round" stroke-linejoin="round"/>`).join('');
      const circles = item.validPoints.map((point) => `<circle class="series-point" cx="${x(point.date).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="${item.isSparse ? 4 : 3.2}" fill="${item.isSparse ? '#fff' : color}" stroke="${color}" stroke-width="${item.isSparse ? 2.2 : 0}"><title>${escapeHtml(item.label)} ${point.date}: ${formatWeight(point.value)}</title></circle>`).join('');
      const signalMarkers = renderSeriesSignalMarkers(item.signalPoints, x, y);
      const delta = item.periodDelta === null ? '계산 불가' : formatPercentPoint(item.periodDelta);
      const signalCount = item.signalPoints.length ? `, 기간 내 이벤트/방향 신호 ${item.signalPoints.length}개` : '';
      const ariaLabel = `${item.rank ? `${item.rank}위 ` : ''}${item.fullLabel}: 최신 ${formatWeight(item.latestWeight)}, 기간 변화 ${delta}${signalCount}`;
      return `<g class="chart-series" tabindex="0" focusable="true" aria-label="${escapeAttribute(ariaLabel)}" style="--series-stroke:${widthByRank}px"><title>${escapeHtml(ariaLabel)}</title>${hitPaths}${segmentPaths}${circles}${signalMarkers}</g>`;
    }).join('');
    const endLabels = renderEndLabels(buildEndLabels(series, x, y, margin.top, height - margin.bottom), colorByKey);
    const summaryCards = renderChartSummaryCards(series, colorByKey);
    const firstDate = new Date(minDate).toISOString().slice(0, 10);
    const lastDate = new Date(maxDate).toISOString().slice(0, 10);
    const axisNote = useZoomedAxis ? `가독성을 위해 Y축을 ${formatAxisWeight(yMin)}부터 표시` : 'Y축은 0% 기준';
    const summaryText = `${firstDate}부터 ${lastDate}까지 최신 TOP10 ${series.length}개 종목 비중 추이. ${axisNote}. 라인에 마우스를 올리거나 키보드 포커스하면 해당 종목의 기간 내 편입·편출 이벤트와 매수·매도 방향 신호가 마커로 표시됩니다.`;
    target.innerHTML = `
      <p class="sr-only" id="weight-chart-summary">${escapeHtml(summaryText)}</p>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="weight-chart-svg-title weight-chart-svg-desc">
        <title id="weight-chart-svg-title">TOP10 비중 변화 그래프</title>
        <desc id="weight-chart-svg-desc">${escapeHtml(summaryText)}</desc>
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>
        ${yGrid}
        ${xGrid}
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="#aab7cf"/>
        <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#aab7cf"/>
        <text class="axis-title" x="${margin.left}" y="20">TOP10 비중(%)</text>
        <text class="axis-note" x="${width - margin.right}" y="22" text-anchor="end">${escapeHtml(axisNote)}</text>
        <text class="axis-range" x="${margin.left + innerWidth / 2}" y="${height - 22}" text-anchor="middle">기간 ${escapeHtml(firstDate)} → ${escapeHtml(lastDate)}</text>
        ${paths}
        ${endLabels}
      </svg>
      <div class="chart-summary-grid">${summaryCards}</div>
    `;
  }

  function renderEndLabels(labels, colorByKey) {
    return asArray(labels).map((item) => {
      const color = colorByKey.get(item.key) || '#475467';
      return `<g class="line-end-label"><line x1="${item.x1.toFixed(1)}" x2="${item.x2.toFixed(1)}" y1="${item.y1.toFixed(1)}" y2="${item.y2.toFixed(1)}" stroke="${color}" stroke-width="1.2"/><text x="${item.x2 + 6}" y="${(item.y2 + 4).toFixed(1)}" fill="${color}">${escapeHtml(item.text)}</text></g>`;
    }).join('');
  }

  function renderSeriesSignalMarkers(signalPoints, x, y) {
    const markers = asArray(signalPoints).filter((point) => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.date)));
    if (!markers.length) return '';
    return `<g class="series-signal-layer">${markers.map((point) => {
      const kind = stringOr(point.kind, point.direction, 'signal');
      const isSellLike = point.direction === 'sell' || kind === 'exit';
      const markerX = x(point.date);
      const slot = numberOr(point.slot, 0);
      const markerY = y(point.value) + (isSellLike ? 20 + slot * 14 : -18 - slot * 14);
      const label = point.actionLabel || (point.direction === 'buy' ? '매수 관찰' : point.direction === 'sell' ? '매도 관찰' : '편입 이벤트');
      const residualText = point.residual === null ? '' : ` · 잔차 ${formatPercentPoint(point.residual)}`;
      const title = `${point.date} ${label}${residualText} · 비중 ${formatWeight(point.value)}`;
      const strengthClass = point.strength === 'watch' ? 'signal-watch' : 'signal-strong';
      const classes = `series-signal signal-${kind} ${strengthClass}`;
      const glyph = stringOr(point.glyph, point.direction === 'buy' ? '↑' : point.direction === 'sell' ? '↓' : '•');
      return `<g class="${escapeAttribute(classes)}" transform="translate(${markerX.toFixed(1)} ${markerY.toFixed(1)})"><title>${escapeHtml(title)}</title><circle r="${point.strength === 'watch' ? 7 : 8}"/><text text-anchor="middle" dominant-baseline="central">${escapeHtml(glyph)}</text></g>`;
    }).join('')}</g>`;
  }

  function renderChartSummaryCards(series, colorByKey) {
    return asArray(series).slice(0, 10).map((item, index) => {
      const color = colorByKey.get(item.key) || CHART_COLORS[index % CHART_COLORS.length];
      const label = item.rank ? `${item.rank}. ${item.label}` : item.label;
      const delta = item.periodDelta === null ? '-' : formatPercentPoint(item.periodDelta);
      return `<div class="chart-summary-item"><span class="legend-key" style="background:${color}"></span><strong>${escapeHtml(label)}</strong><em>${escapeHtml(formatWeight(item.latestWeight))}</em><small>기간 Δ ${escapeHtml(delta)} · 데이터 ${item.validPoints.length}/${item.points.length}일</small></div>`;
    }).join('');
  }

  function buildWeightSeries(history, latestTop10) {
    const keys = latestTop10.map((row) => holdingKey(row)).filter(Boolean).slice(0, 10);
    return keys.map((key, orderIndex) => {
      const latest = latestTop10.find((row) => holdingKey(row) === key) || {};
      const label = latest.ticker || latest.name || key;
      const points = history.map((snapshot) => {
        const hasFullHoldings = Boolean(snapshot.holdings?.length);
        const universe = hasFullHoldings ? snapshot.holdings : snapshot.top10;
        const holding = universe.find((row) => holdingKey(row) === key);
        return { date: snapshot.date, value: holding?.weightPercent ?? null };
      });
      const signalPoints = buildSeriesSignalPoints(history, key, points);
      const validPoints = points.filter((point) => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.date)));
      const first = validPoints[0] || null;
      const last = validPoints.at(-1) || null;
      const periodDelta = first && last ? last.value - first.value : null;
      const rank = finiteOrNull(latest.rank) || orderIndex + 1;
      return {
        key,
        label: truncateLabel(label, 18),
        fullLabel: label,
        rank,
        latestWeight: finiteOrNull(latest.weightPercent),
        periodDelta,
        points,
        validPoints,
        signalPoints,
        isSparse: validPoints.length < points.length * 0.75,
      };
    }).filter((item) => item.points.some((point) => point.value > 0));
  }

  function buildSeriesSignalPoints(history, key, points) {
    const pointByDate = new Map(asArray(points).map((point) => [point.date, point]));
    return asArray(history).flatMap((snapshot) => {
      const decomposition = asArray(snapshot.decomposition);
      const row = decomposition.find((item) => holdingKey(item) === key);
      if (!row) return [];
      const weight = finiteOrNull(row.actualWeightPercent) ?? finiteOrNull(pointByDate.get(snapshot.date)?.value);
      if (weight === null) return [];
      return rowChartSignals(row).map((signal, slot) => ({
        date: snapshot.date,
        value: weight,
        residual: finiteOrNull(row.deltaResidualPercentPoint),
        actionEstimate: signal.estimate,
        actionLabel: stringOr(signal.label, row.actionLabel, signal.direction === 'buy' ? '매수 관찰' : signal.direction === 'sell' ? '매도·축소 관찰' : '편입 이벤트'),
        actionExplanation: stringOr(signal.explanation, row.actionExplanation, row.message),
        direction: signal.direction,
        kind: signal.kind,
        glyph: signal.glyph,
        strength: signal.strength,
        slot,
      }));
    });
  }

  function rowChartSignals(row) {
    if (!isRecord(row)) return [];
    const lifecycle = lifecycleDirection(row);
    const residual = residualDirection(row);
    return [lifecycle, residual].filter(Boolean);
  }

  function lifecycleDirection(row) {
    if (!isRecord(row)) return null;
    const membership = stringOr(row.membershipChange, '');
    const classification = stringOr(row.classification, '');
    const lifecycle = stringOr(row.holdingLifecycle, row.positionStatus, '');
    if (classification === 'new_entry' || lifecycle === 'new_holding') {
      return {
        estimate: classification || 'new_entry',
        direction: 'entry',
        kind: 'entry',
        glyph: '＋',
        strength: 'strong',
        label: '신규 편입',
        explanation: '전일 보유가 확인되지 않은 신규 보유 이벤트입니다. 잔차 기반 매수 추정과는 별도로 표시합니다.',
      };
    }
    if (membership === 'top10_entry') {
      return {
        estimate: 'top10_entry',
        direction: 'entry',
        kind: 'entry',
        glyph: '＋',
        strength: 'watch',
        label: 'TOP10 편입',
        explanation: '이미 보유했거나 전일 10위 밖이던 종목이 TOP10에 들어온 이벤트입니다.',
      };
    }
    if (classification === 'fund_exit' || lifecycle === 'fund_exit') {
      return {
        estimate: classification || 'fund_exit',
        direction: 'exit',
        kind: 'exit',
        glyph: '－',
        strength: 'strong',
        label: '보유 제외',
        explanation: '보유목록에서 제외된 이벤트입니다.',
      };
    }
    if (membership === 'top10_exit') {
      return {
        estimate: 'top10_exit',
        direction: 'exit',
        kind: 'exit',
        glyph: '－',
        strength: 'watch',
        label: 'TOP10 편출',
        explanation: '보유는 유지됐지만 TOP10 밖으로 내려간 이벤트입니다.',
      };
    }
    return null;
  }

  function residualDirection(row) {
    if (!isRecord(row)) return null;
    const estimate = stringOr(row.actionEstimate, '');
    if (estimate === 'likely_buy' || estimate === 'weak_buy_watch') {
      return { estimate, direction: 'buy', strength: estimate === 'likely_buy' ? 'strong' : 'watch' };
    }
    if (estimate === 'likely_sell' || estimate === 'weak_sell_watch') {
      return { estimate, direction: 'sell', strength: estimate === 'likely_sell' ? 'strong' : 'watch' };
    }
    const classification = stringOr(row.classification, '');
    if (classification !== 'likely_buy' && classification !== 'likely_sell' && classification !== 'residual_watch') return null;
    const residual = finiteOrNull(row.deltaResidualPercentPoint);
    if (residual === null || residual === 0) return null;
    const direction = residual > 0 ? 'buy' : 'sell';
    const strength = classification === 'residual_watch' ? 'watch' : 'strong';
    return { estimate: classification, direction, strength };
  }

  function splitPointSegments(points) {
    const segments = [];
    let current = [];
    asArray(points).forEach((point) => {
      if (Number.isFinite(point.value) && Number.isFinite(Date.parse(point.date))) {
        current.push(point);
      } else if (current.length) {
        segments.push(current);
        current = [];
      }
    });
    if (current.length) segments.push(current);
    return segments;
  }

  function buildEndLabels(series, x, y, topY, bottomY) {
    const labels = asArray(series)
      .map((item) => {
        const point = item.validPoints.at(-1);
        if (!point) return null;
        return {
          key: item.key,
          y1: y(point.value),
          y2: y(point.value),
          x1: x(point.date),
          x2: x(point.date) + 26,
          text: `${item.rank}. ${item.label} ${formatWeight(point.value)}`,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.y2 - b.y2);
    let previousY = -Infinity;
    labels.forEach((label) => {
      if (label.y2 - previousY < 18) label.y2 = previousY + 18;
      previousY = label.y2;
    });
    const overflow = labels.length ? labels.at(-1).y2 - (bottomY - 4) : 0;
    if (overflow > 0) labels.forEach((label) => { label.y2 -= overflow; });
    for (let index = labels.length - 2; index >= 0; index -= 1) {
      if (labels[index + 1].y2 - labels[index].y2 < 18) labels[index].y2 = labels[index + 1].y2 - 18;
    }
    labels.forEach((label) => { label.y2 = Math.max(topY + 8, Math.min(label.y2, bottomY - 4)); });
    return labels;
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
      <div class="source-item"><strong>수익률 커버리지</strong><span>${formatCoverage(summary.returnCoverage)} · ${escapeHtml(summary.returnCoverageStatus || 'insufficient')} · ${escapeHtml(formatCoverageUniverse(summary.returnCoverageUniverse))}</span><small>가격 반영 비중 ${escapeHtml(formatWeight(summary.validReturnWeightPercent))} / 전체 ${escapeHtml(formatWeight(summary.totalReturnWeightPercent))} · 미가격 ${escapeHtml(formatWeight(summary.unpricedReturnWeightPercent))}</small></div>
      <div class="source-item"><strong>벤치마크·환율</strong><span>벤치마크 ${escapeHtml(formatReturn(summary.benchmarkReturn))} · ${escapeHtml(formatFxCoverage(latest?.decomposition || []))}</span><small>벤치마크는 가격 확보 종목의 전일비중 가중 수익률이며 실제 ETF NAV 수익률이 아닙니다. 외부 USD/JPY/HKD 종가는 가능한 경우 환율 수익률을 곱해 KRW 기준으로 환산합니다.</small></div>
      <div class="source-item"><strong>잔차 판정</strong><span>가격 우세는 no-trade 가격 효과가 우세하다는 뜻이며 완전 설명/무거래 확정이 아닙니다.</span><small>중간 잔차도 방향에 따라 ‘약한 매수 관찰’ 또는 ‘약한 매도·축소 관찰’을 설명하고, 임계치 이상 방향성 잔차만 ‘매수·매도 가능성’으로 표시합니다.</small></div>
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
      const action = signal.actionLabel ? `${signal.actionLabel} · ` : '';
      const signalMessage = signal.actionExplanation || signal.message || signal.type;
      article.innerHTML = `
        ${classificationBadge(signal.type || 'signal').outerHTML}
        <strong>${escapeHtml(signal.etfName || '')} ${escapeHtml(signal.name || signal.ticker || '신호')}</strong>
        <p>${escapeHtml(formatMaybeDate(signal.date))} · ${escapeHtml(action)}${escapeHtml(signalMessage)} · ${formatWeight(signal.previousWeightPercent)} → ${formatWeight(signal.weightPercent)}</p>
      `;
      return article;
    }));
  }

  function renderSignalTables() {
    const target = $('#etf-signal-tables');
    if (!target || !state.dashboard) return;
    const tableGroups = buildSignalTableGroups();
    if (!tableGroups.some((group) => group.rows.length)) {
      target.innerHTML = '<div class="skeleton-line">선택 기간에 표시할 TOP10 신호·비중 변화가 없습니다.</div>';
      return;
    }
    target.replaceChildren(...tableGroups.map(({ etf, rows, history }) => renderEtfSignalTableCard(etf, rows, history)));
  }

  function buildSignalTableGroups(dashboard = state.dashboard, startDate = state.startDate, endDate = state.endDate) {
    if (!dashboard) return [];
    return asArray(dashboard.etfs).map((etf) => ({
      etf,
      rows: buildEtfSignalTableRows(etf, startDate, endDate),
      history: filterHistory(etf.history, startDate, endDate),
    }));
  }

  function renderEtfSignalTableCard(etf, rows, history) {
    const article = document.createElement('article');
    article.className = 'panel signal-table-card';
    const counts = signalTableCounts(rows);
    const filter = signalTableFilterFor(etf.id);
    const filteredRows = filterSignalTableRows(rows, filter);
    const visibleRows = filteredRows.slice(0, filter.limit);
    const hiddenRows = Math.max(filteredRows.length - visibleRows.length, 0);
    const periodStart = history[0]?.date || etf.availableStartDate || state.startDate;
    const periodEnd = history.at(-1)?.date || etf.availableEndDate || state.endDate;
    article.innerHTML = `
      <div class="signal-table-header">
        <div>
          <p class="eyebrow">${escapeHtml(etf.provider || 'ETF')}</p>
          <h4>${escapeHtml(etf.shortName || etf.name || 'ETF')}</h4>
          <p>${escapeHtml(formatMaybeDate(periodStart))} → ${escapeHtml(formatMaybeDate(periodEnd))} · ${history.length.toLocaleString('ko-KR')}개 스냅샷</p>
        </div>
        <div class="signal-count-strip" aria-label="신호 요약">
          <span>전체 <strong>${counts.total.toLocaleString('ko-KR')}</strong></span>
          <span class="marker-entry">편입 <strong>${counts.entry.toLocaleString('ko-KR')}</strong></span>
          <span class="marker-exit">편출 <strong>${counts.exit.toLocaleString('ko-KR')}</strong></span>
          <span class="marker-buy">매수 관찰 <strong>${counts.buy.toLocaleString('ko-KR')}</strong></span>
          <span class="marker-sell">매도 관찰 <strong>${counts.sell.toLocaleString('ko-KR')}</strong></span>
        </div>
      </div>
      <div class="signal-table-toolbar" aria-label="${escapeAttribute(etf.shortName || etf.name || 'ETF')} 표 필터">
        <div class="signal-filter-chips" role="group" aria-label="이벤트 필터">
          ${signalBucketButton(etf.id, filter, 'signal', '핵심 신호', counts.entry + counts.exit + counts.buy + counts.sell)}
          ${signalBucketButton(etf.id, filter, 'all', '전체 TOP10', rows.length)}
          ${signalBucketButton(etf.id, filter, 'entry', '편입', counts.entry)}
          ${signalBucketButton(etf.id, filter, 'exit', '편출', counts.exit)}
          ${signalBucketButton(etf.id, filter, 'buy', '매수 관찰', counts.buy)}
          ${signalBucketButton(etf.id, filter, 'sell', '매도 관찰', counts.sell)}
        </div>
        <div class="signal-filter-grid">
          <label>
            <span>종목/티커</span>
            <input type="search" value="${escapeAttribute(filter.query)}" placeholder="MU, SpaceX…" data-etf-id="${escapeAttribute(etf.id)}" data-signal-filter="query" autocomplete="off">
          </label>
          <label>
            <span>순위 조건</span>
            <select data-etf-id="${escapeAttribute(etf.id)}" data-signal-filter="rankScope">
              ${selectOption('all', filter.rankScope, '전체')}
              ${selectOption('current_top10', filter.rankScope, '현재 TOP10')}
              ${selectOption('previous_top10', filter.rankScope, '전일 TOP10')}
              ${selectOption('rank_changed', filter.rankScope, '순위/편입 변화')}
            </select>
          </label>
          <label>
            <span>변화 크기</span>
            <select data-etf-id="${escapeAttribute(etf.id)}" data-signal-filter="magnitude">
              ${selectOption('all', filter.magnitude, '전체')}
              ${selectOption('weight_025', filter.magnitude, `비중 |Δ| ≥ ${SIGNAL_TABLE_WEIGHT_THRESHOLD}pp`)}
              ${selectOption('residual_010', filter.magnitude, `잔차 |Δ| ≥ ${SIGNAL_TABLE_RESIDUAL_THRESHOLD}pp`)}
            </select>
          </label>
          <label>
            <span>정렬</span>
            <select data-etf-id="${escapeAttribute(etf.id)}" data-signal-filter="sort">
              ${selectOption('recent', filter.sort, '최신순')}
              ${selectOption('oldest', filter.sort, '오래된순')}
              ${selectOption('event', filter.sort, '이벤트 우선')}
              ${selectOption('weight_delta', filter.sort, '비중 변화 큰 순')}
              ${selectOption('residual_delta', filter.sort, '잔차 큰 순')}
              ${selectOption('name', filter.sort, '종목명순')}
            </select>
          </label>
          <button type="button" class="ghost-button compact" data-etf-id="${escapeAttribute(etf.id)}" data-signal-reset>필터 초기화</button>
        </div>
        <div class="signal-table-status">
          <span>필터 결과 <strong>${filteredRows.length.toLocaleString('ko-KR')}</strong> / 전체 <strong>${rows.length.toLocaleString('ko-KR')}</strong>건</span>
          <span>현재 <strong>${visibleRows.length.toLocaleString('ko-KR')}</strong>건 표시</span>
        </div>
      </div>
      <div class="table-wrap signal-table-wrap">
        <table class="data-table signal-table">
          <caption>${escapeHtml(etf.shortName || etf.name || 'ETF')} 선택 기간 TOP10 신호와 비중 변화</caption>
          <thead>
            <tr>
              <th scope="col">날짜</th>
              <th scope="col">이벤트/판정</th>
              <th scope="col">종목</th>
              <th scope="col">순위</th>
              <th scope="col">비중 변화</th>
              <th scope="col">가격·잔차</th>
              <th scope="col">해석</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="signal-table-actions">
        <button type="button" class="ghost-button compact" data-etf-id="${escapeAttribute(etf.id)}" data-signal-load-more ${hiddenRows ? '' : 'disabled'}>30개 더 보기</button>
        <button type="button" class="ghost-button compact" data-etf-id="${escapeAttribute(etf.id)}" data-signal-show-all ${hiddenRows ? '' : 'disabled'}>필터 결과 전체 보기</button>
        <span>${hiddenRows ? `${hiddenRows.toLocaleString('ko-KR')}건 더 있음` : '모든 필터 결과 표시 중'}</span>
      </div>
    `;
    const tbody = article.querySelector('tbody');
    if (!visibleRows.length) {
      tbody.innerHTML = '<tr><td colspan="7">필터 조건에 맞는 행이 없습니다. 이벤트·검색·변화 크기 조건을 완화해 보세요.</td></tr>';
      return article;
    }
    tbody.replaceChildren(...visibleRows.map((row) => {
      const tr = document.createElement('tr');
      tr.className = `signal-row ${escapeAttribute(signalBucket(row))}`;
      [
        dateCell(row),
        signalTypeCell(row),
        nameCell(row.name, row.ticker || row.codeRaw),
        rankMoveCell(row),
        weightMoveCell(row),
        priceResidualCell(row),
        interpretationCell(row),
      ].forEach((value) => {
        const td = document.createElement('td');
        if (isDomNode(value)) td.appendChild(value);
        else td.textContent = value === null || value === undefined || value === '' ? '-' : String(value);
        tr.appendChild(td);
      });
      return tr;
    }));
    return article;
  }

  function signalBucketButton(etfId, filter, bucket, label, count) {
    const active = filter.bucket === bucket;
    return `
      <button type="button" class="signal-filter-chip ${active ? 'active' : ''}" aria-pressed="${active ? 'true' : 'false'}" data-etf-id="${escapeAttribute(etfId)}" data-signal-bucket="${escapeAttribute(bucket)}">
        <span>${escapeHtml(label)}</span><strong>${numberOr(count, 0).toLocaleString('ko-KR')}</strong>
      </button>
    `;
  }

  function selectOption(value, selectedValue, label) {
    return `<option value="${escapeAttribute(value)}" ${value === selectedValue ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }

  function normalizeSignalTableFilter(filter) {
    const bucketOptions = new Set(['signal', 'all', 'entry', 'exit', 'buy', 'sell', 'neutral']);
    const rankOptions = new Set(['all', 'current_top10', 'previous_top10', 'rank_changed']);
    const magnitudeOptions = new Set(['all', 'weight_025', 'residual_010']);
    const sortOptions = new Set(['recent', 'oldest', 'event', 'weight_delta', 'residual_delta', 'name']);
    const limit = Math.trunc(numberOr(filter?.limit, SIGNAL_TABLE_INITIAL_LIMIT));
    return {
      bucket: bucketOptions.has(filter?.bucket) ? filter.bucket : SIGNAL_TABLE_DEFAULT_FILTER.bucket,
      query: stringOr(filter?.query, '').trim(),
      rankScope: rankOptions.has(filter?.rankScope) ? filter.rankScope : SIGNAL_TABLE_DEFAULT_FILTER.rankScope,
      magnitude: magnitudeOptions.has(filter?.magnitude) ? filter.magnitude : SIGNAL_TABLE_DEFAULT_FILTER.magnitude,
      sort: sortOptions.has(filter?.sort) ? filter.sort : SIGNAL_TABLE_DEFAULT_FILTER.sort,
      limit: Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, limit)),
    };
  }

  function filterSignalTableRows(rows, filter) {
    const normalized = normalizeSignalTableFilter(filter);
    const query = normalized.query.toLocaleLowerCase('ko-KR');
    return asArray(rows)
      .filter((row) => matchesSignalBucketFilter(row, normalized.bucket))
      .filter((row) => matchesSignalQuery(row, query))
      .filter((row) => matchesSignalRankScope(row, normalized.rankScope))
      .filter((row) => matchesSignalMagnitude(row, normalized.magnitude))
      .sort((a, b) => signalTableSortComparator(a, b, normalized.sort));
  }

  function matchesSignalBucketFilter(row, bucket) {
    const rowBucket = signalBucket(row);
    if (bucket === 'all') return true;
    if (bucket === 'signal') return rowBucket !== 'neutral';
    return rowBucket === bucket;
  }

  function matchesSignalQuery(row, query) {
    if (!query) return true;
    return [
      row?.name,
      row?.ticker,
      row?.codeRaw,
      row?.instrumentId,
      row?.etfName,
    ].some((value) => stringOr(value).toLocaleLowerCase('ko-KR').includes(query));
  }

  function matchesSignalRankScope(row, scope) {
    if (scope === 'all') return true;
    if (scope === 'current_top10') return row?.currentIsTop10 === true;
    if (scope === 'previous_top10') return row?.previousWasTop10 === true;
    if (scope === 'rank_changed') {
      const previousRank = finiteOrNull(row?.previousRank);
      const rank = finiteOrNull(row?.rank);
      return Boolean(row?.membershipChange)
        || row?.currentIsTop10 !== row?.previousWasTop10
        || (previousRank !== null && rank !== null && previousRank !== rank);
    }
    return true;
  }

  function matchesSignalMagnitude(row, magnitude) {
    if (magnitude === 'all') return true;
    if (magnitude === 'weight_025') return Math.abs(numberOr(row?.deltaActualPercentPoint, 0)) >= SIGNAL_TABLE_WEIGHT_THRESHOLD;
    if (magnitude === 'residual_010') return Math.abs(numberOr(row?.deltaResidualPercentPoint, 0)) >= SIGNAL_TABLE_RESIDUAL_THRESHOLD;
    return true;
  }

  function signalTableSortComparator(a, b, sort) {
    if (sort === 'oldest') return signalTableDateAsc(a, b) || signalTablePriority(a) - signalTablePriority(b) || signalTableNameAsc(a, b);
    if (sort === 'event') return signalTablePriority(a) - signalTablePriority(b) || signalTableDateDesc(a, b) || signalTableNameAsc(a, b);
    if (sort === 'weight_delta') return absoluteDesc(a, b, 'deltaActualPercentPoint') || signalTableDateDesc(a, b) || signalTableNameAsc(a, b);
    if (sort === 'residual_delta') return absoluteDesc(a, b, 'deltaResidualPercentPoint') || signalTableDateDesc(a, b) || signalTableNameAsc(a, b);
    if (sort === 'name') return signalTableNameAsc(a, b) || signalTableDateDesc(a, b);
    return signalTableRowComparator(a, b);
  }

  function signalTableRowComparator(a, b) {
    return signalTableDateDesc(a, b)
      || signalTablePriority(a) - signalTablePriority(b)
      || numberOr(a.displayOrder, 999) - numberOr(b.displayOrder, 999)
      || numberOr(a.rank, 999) - numberOr(b.rank, 999)
      || signalTableNameAsc(a, b);
  }

  function signalTableDateDesc(a, b) {
    return stringOr(b.date, b.snapshotDate).localeCompare(stringOr(a.date, a.snapshotDate));
  }

  function signalTableDateAsc(a, b) {
    return stringOr(a.date, a.snapshotDate).localeCompare(stringOr(b.date, b.snapshotDate));
  }

  function signalTableNameAsc(a, b) {
    return stringOr(a.name, a.ticker, a.codeRaw).localeCompare(stringOr(b.name, b.ticker, b.codeRaw), 'ko');
  }

  function absoluteDesc(a, b, field) {
    return Math.abs(numberOr(b?.[field], 0)) - Math.abs(numberOr(a?.[field], 0));
  }

  function buildEtfSignalTableRows(etf, startDate, endDate) {
    const rows = [];
    filterHistory(etf?.history || [], startDate, endDate).forEach((snapshot) => {
      sortAttributionRows(snapshot.decomposition || []).forEach((row) => {
        if (!includeSignalTableRow(row)) return;
        rows.push({
          ...row,
          etfId: etf.id,
          etfName: etf.shortName || etf.name,
          snapshotDate: snapshot.date,
          category: signalBucket(row),
        });
      });
    });
    return rows.sort(signalTableRowComparator);
  }

  function includeSignalTableRow(row) {
    if (!isRecord(row)) return false;
    if (row.currentIsTop10 || row.previousWasTop10) return true;
    return signalBucket(row) !== 'neutral';
  }

  function signalTableCounts(rows) {
    return asArray(rows).reduce((counts, row) => {
      const bucket = signalBucket(row);
      counts.total += 1;
      if (bucket === 'entry') counts.entry += 1;
      else if (bucket === 'exit') counts.exit += 1;
      else if (bucket === 'buy') counts.buy += 1;
      else if (bucket === 'sell') counts.sell += 1;
      return counts;
    }, { total: 0, entry: 0, exit: 0, buy: 0, sell: 0 });
  }

  function signalBucket(row) {
    const membership = stringOr(row?.membershipChange, '');
    const classification = stringOr(row?.classification, '');
    const lifecycle = stringOr(row?.holdingLifecycle, row?.positionStatus, '');
    const estimate = stringOr(row?.actionEstimate, '');
    if (membership === 'top10_entry' || classification === 'new_entry' || lifecycle === 'new_holding') return 'entry';
    if (membership === 'top10_exit' || classification === 'fund_exit' || lifecycle === 'fund_exit') return 'exit';
    if (estimate === 'likely_buy' || estimate === 'weak_buy_watch' || classification === 'likely_buy') return 'buy';
    if (estimate === 'likely_sell' || estimate === 'weak_sell_watch' || classification === 'likely_sell') return 'sell';
    if (classification === 'residual_watch') {
      const residual = finiteOrNull(row?.deltaResidualPercentPoint);
      if (residual > 0) return 'buy';
      if (residual < 0) return 'sell';
    }
    return 'neutral';
  }

  function signalTablePriority(row) {
    const priorities = { entry: 0, exit: 1, buy: 2, sell: 3, neutral: 4 };
    return priorities[signalBucket(row)] ?? 9;
  }

  function dateCell(row) {
    const div = document.createElement('div');
    div.className = 'date-cell';
    div.innerHTML = `<strong>${escapeHtml(formatMaybeDate(row.date || row.snapshotDate))}</strong><span>전일 ${escapeHtml(formatMaybeDate(row.previousDate))}</span>`;
    return div;
  }

  function signalTypeCell(row) {
    const div = document.createElement('div');
    div.className = 'badge-stack signal-badge-stack';
    const membership = stringOr(row?.membershipChange, '');
    const classification = stringOr(row?.classification, 'insufficient_data');
    if (membership) div.appendChild(classificationBadge(membership));
    if (!membership || membership !== classification) div.appendChild(classificationBadge(classification));
    const action = actionHint(row);
    if (action.label) {
      const actionText = document.createElement('span');
      actionText.className = `action-hint-text ${escapeAttribute(action.kind)}`;
      actionText.textContent = action.label;
      div.appendChild(actionText);
    }
    return div;
  }

  function rankMoveCell(row) {
    const div = document.createElement('div');
    div.className = 'rank-move-cell';
    const previous = rankLabel(row.previousRank, row.previousWasTop10 ? '전일 TOP10' : '전일 없음');
    const current = rankLabel(row.rank, row.currentIsTop10 ? '현재 TOP10' : '10위 밖');
    div.innerHTML = `<strong>${escapeHtml(current)}</strong><span>${escapeHtml(previous)} → ${escapeHtml(current)}</span>`;
    return div;
  }

  function rankLabel(value, fallback = '-') {
    const rank = finiteOrNull(value);
    return rank === null || rank <= 0 ? fallback : `${rank.toLocaleString('ko-KR')}위`;
  }

  function weightMoveCell(row) {
    const div = document.createElement('div');
    div.className = 'weight-move-cell';
    const actual = finiteOrNull(row.actualWeightPercent);
    const previous = finiteOrNull(row.previousWeightPercent);
    const delta = finiteOrNull(row.deltaActualPercentPoint) ?? (actual !== null && previous !== null ? actual - previous : null);
    div.innerHTML = `<strong>${escapeHtml(formatWeight(previous))} → ${escapeHtml(formatWeight(actual))}</strong><span class="${escapeAttribute(deltaClass(delta))}">Δ ${escapeHtml(formatPercentPoint(delta))}</span>`;
    return div;
  }

  function priceResidualCell(row) {
    const div = document.createElement('div');
    div.className = 'price-residual-cell';
    const price = finiteOrNull(row.deltaPricePercentPoint);
    const residual = finiteOrNull(row.deltaResidualPercentPoint);
    div.innerHTML = `<strong>가격 ${escapeHtml(formatPercentPoint(price))}</strong><span class="${escapeAttribute(deltaClass(residual))}">잔차 ${escapeHtml(formatPercentPoint(residual))}</span>`;
    return div;
  }

  function interpretationCell(row) {
    const div = document.createElement('div');
    div.className = 'interpretation-cell';
    const action = actionHint(row);
    const headline = action.label || classLabel(row.classification || row.membershipChange || 'signal');
    const detail = action.explanation || row.message || '';
    const confidence = row.confidence ? ` · ${row.confidence}` : '';
    div.innerHTML = `<strong>${escapeHtml(headline)}</strong><span>${escapeHtml(detail || '추가 해석 없음')}${escapeHtml(confidence)}</span>`;
    return div;
  }

  function deltaClass(value) {
    const num = finiteOrNull(value);
    if (num === null || Math.abs(num) < 0.000001) return 'delta-flat';
    return num > 0 ? 'delta-up' : 'delta-down';
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
    const action = actionHint(row);
    if (action.label) {
      const actionText = document.createElement('span');
      actionText.className = `action-hint-text ${escapeAttribute(action.kind)}`;
      actionText.textContent = action.label;
      div.appendChild(actionText);
    }
    if (action.explanation) {
      const explanation = document.createElement('small');
      explanation.className = 'action-explanation';
      explanation.textContent = action.explanation;
      div.appendChild(explanation);
    }
    return div;
  }

  function actionHint(row) {
    const estimate = stringOr(row?.actionEstimate, '');
    const classification = stringOr(row?.classification, '');
    const residual = finiteOrNull(row?.deltaResidualPercentPoint);
    const kind = estimate || classification;
    const derivedLabel = residual === null
      ? ''
      : residual > 0
        ? '약한 매수 관찰'
        : residual < 0
          ? '약한 매도·축소 관찰'
          : '';
    const label = stringOr(row?.actionLabel, classification === 'residual_watch' ? derivedLabel : '');
    const explanation = stringOr(row?.actionExplanation, row?.message, '');
    return { kind, label, explanation };
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
      price_explained: '가격 우세',
      price_aligned: '가격 우세',
      residual_watch: '잔차 관찰',
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

  function buildDateTicks(dates, maxTicks = 14, plotWidth = 820) {
    const unique = Array.from(new Set(asArray(dates).filter((date) => Number.isFinite(Date.parse(date))))).sort();
    if (unique.length <= 2) return unique;
    const first = unique[0];
    const last = unique.at(-1);
    const firstTime = Date.parse(first);
    const lastTime = Date.parse(last);
    const rangeMs = Math.max(lastTime - firstTime, 1);
    const safeMaxTicks = Math.max(2, Math.min(Math.floor(maxTicks), unique.length));
    const oneYearMs = 366 * 24 * 60 * 60 * 1000;
    const labelWidth = rangeMs > oneYearMs ? 88 : 58;
    const minGapMs = rangeMs * (labelWidth / Math.max(plotWidth, labelWidth));
    if (unique.length <= safeMaxTicks) return enforceDateTickSpacing(unique, minGapMs, first, last);
    const selected = new Set([first, last]);
    for (let index = 1; index < safeMaxTicks - 1; index += 1) {
      const targetTime = firstTime + (rangeMs * index) / (safeMaxTicks - 1);
      const nearest = nearestDateTick(unique, targetTime, selected);
      if (nearest) selected.add(nearest);
    }
    return enforceDateTickSpacing(Array.from(selected), minGapMs, first, last);
  }

  function nearestDateTick(dates, targetTime, excluded = new Set()) {
    let best = '';
    let bestDistance = Infinity;
    asArray(dates).forEach((date) => {
      if (excluded.has(date)) return;
      const distance = Math.abs(Date.parse(date) - targetTime);
      if (distance < bestDistance) {
        best = date;
        bestDistance = distance;
      }
    });
    return best;
  }

  function enforceDateTickSpacing(dates, minGapMs, first, last) {
    const ticks = [];
    uniqueDateTicks(dates).forEach((date) => {
      if (!ticks.length) {
        ticks.push(date);
        return;
      }
      const previous = ticks.at(-1);
      const gap = Date.parse(date) - Date.parse(previous);
      if (date === last && previous !== first && gap < minGapMs) {
        ticks[ticks.length - 1] = date;
        return;
      }
      if (gap >= minGapMs || date === first || date === last) ticks.push(date);
    });
    if (ticks[0] !== first) ticks.unshift(first);
    if (ticks.at(-1) !== last) {
      const gap = Date.parse(last) - Date.parse(ticks.at(-1));
      if (ticks.length > 1 && gap < minGapMs) ticks[ticks.length - 1] = last;
      else ticks.push(last);
    }
    return uniqueDateTicks(ticks);
  }

  function uniqueDateTicks(dates) {
    return Array.from(new Set(asArray(dates).filter(Boolean))).sort();
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
      yahoo_fx_query1: 'Yahoo FX',
      yahoo_fx_query2: 'Yahoo FX 보조',
      stooq_csv: 'Stooq CSV',
      stooq_fx_csv: 'Stooq FX CSV',
      finance_datareader: 'FinanceDataReader',
      fx_adjusted_external_close: '외부 종가+환율',
      external_close_fx_adjusted_krw: '외부 종가+환율',
      external_close_local_currency: '외부 종가(환율 미반영)',
      external_close_krw: '외부 KRW 종가',
    };
    const key = stringOr(value, '');
    return labels[key] || key || '가격 소스 없음';
  }

  function formatCoverage(value) {
    const num = finiteOrNull(value);
    if (num === null) return '-';
    return `${(num * 100).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}%`;
  }

  function formatCoverageUniverse(value) {
    const labels = {
      full_holdings: '전체 보유종목',
      priced_subset_of_full_holdings: '전체 보유종목 중 가격확보분',
      top10_fallback: 'TOP10 fallback',
      priced_subset_of_top10_fallback: 'TOP10 중 가격확보분',
      none: '보유종목 없음',
    };
    const key = stringOr(value, '');
    return labels[key] || key || '범위 알 수 없음';
  }

  function formatFxCoverage(rows) {
    const tracked = asArray(rows).filter((row) => row.currency && row.currency !== 'KRW' && row.currency !== 'UNKNOWN');
    if (!tracked.length) return '환율 보정 대상 없음';
    const applied = tracked.filter((row) => row.fxApplied === true).length;
    return `환율 보정 ${applied}/${tracked.length}개`;
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

  function schemaWarning(value) {
    const text = stringOr(value, '');
    if (!text || text === 'fallback') return '';
    const major = Number(text.split('.')[0]);
    return major === SUPPORTED_SCHEMA_MAJOR ? '' : `schema ${text} 미지원 가능`;
  }

  function truncateLabel(value, maxLength) {
    const text = stringOr(value, '');
    return text.length > maxLength ? `${text.slice(0, Math.max(maxLength - 1, 1))}…` : text;
  }

  function setDashboardForTests(dashboard) {
    state.dashboard = dashboard;
    initializeSelection(dashboard);
    return stateSnapshotForTests();
  }

  function stateSnapshotForTests() {
    return {
      selectedEtfId: state.selectedEtfId,
      startDate: state.startDate,
      endDate: state.endDate,
      signalTableRows: buildSignalTableGroups().map((group) => {
        const filter = signalTableFilterFor(group.etf.id);
        const filteredRows = filterSignalTableRows(group.rows, filter);
        return {
          etfId: group.etf.id,
          rows: group.rows.length,
          filteredRows: filteredRows.length,
          visibleRows: filteredRows.slice(0, filter.limit).length,
          filter: { ...filter },
          counts: signalTableCounts(group.rows),
        };
      }),
    };
  }

  function setSignalTableFilterForTests(etfId, patch) {
    updateSignalTableFilter(etfId, patch);
    return stateSnapshotForTests();
  }

  function safeHttpUrl(value, fallback) {
    try {
      const url = new URL(stringOr(value, fallback), window.location.href);
      if (url.protocol !== 'https:') return fallback;
      if (!ALLOWED_LINK_HOSTS.has(url.hostname)) return fallback;
      return url.href;
    } catch {
      return fallback;
    }
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
      buildSeriesSignalPoints,
      rowChartSignals,
      lifecycleDirection,
      residualDirection,
      splitPointSegments,
      buildNiceTicks,
      buildDateTicks,
      formatAxisWeight,
      formatAxisDate,
      sortAttributionRows,
      buildSignalTableGroups,
      buildEtfSignalTableRows,
      signalTableDefaultFilter,
      filterSignalTableRows,
      signalBucket,
      signalTableCounts,
      handleEtfSelectionChange,
      handleDateRangeChange,
      handleDateRangeReset,
      stateSnapshotForTests,
      setDashboardForTests,
      setSignalTableFilterForTests,
      actionHint,
      priceIdentifierCell,
      holdingKey,
      classLabel,
      formatWeight,
      formatReturn,
      formatPriceSource,
      formatCoverage,
      formatCoverageUniverse,
      formatFxCoverage,
      formatAutomationStatus,
      FALLBACK_DASHBOARD,
      AUTOMATION_STATUS_URL,
      QUANT_DASHBOARD_URL,
      WORKFLOW_URL,
      MANUAL_UPDATE_COMMAND,
    };
  }
})();
