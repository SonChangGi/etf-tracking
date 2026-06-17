(() => {
  'use strict';

  const DATA_URL = 'data/dashboard.json';
  const STATUS_URL = 'data/status.json';
  const QUANT_DASHBOARD_URL = 'https://sonchanggi.github.io/quant-dashboard/';
  const COLORS = ['#2457d6', '#0f766e', '#e11d48', '#f97316', '#7c3aed', '#0891b2', '#059669', '#db2777', '#2563eb', '#9333ea'];
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
      const [dashboardResult, statusResult] = await Promise.all([
        getJsonBestEffort(DATA_URL),
        getJsonBestEffort(STATUS_URL),
      ]);
      const dashboard = parseDashboard(dashboardResult.ok ? dashboardResult.data : FALLBACK_DASHBOARD);
      dashboard.statusPayload = statusResult.ok ? statusResult.data : null;
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
      sourceStatus: stringOr(snapshot.sourceStatus, ''),
      sourceConfidence: stringOr(snapshot.sourceConfidence, ''),
      sourceWarning: stringOr(snapshot.sourceWarning, ''),
      totalHoldings: numberOr(snapshot.totalHoldings, 0),
      fetchedAt: stringOr(snapshot.fetchedAt, ''),
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
      isPriceTracked: Boolean(row.isPriceTracked),
    };
  }

  function normalizeDecomposition(row) {
    return {
      date: stringOr(row.date, ''),
      previousDate: stringOr(row.previousDate, ''),
      name: stringOr(row.name, ''),
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
      classification: stringOr(row.classification, 'insufficient_data'),
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
      ticker: stringOr(signal.ticker, ''),
      rank: finiteOrNull(signal.rank),
      previousRank: finiteOrNull(signal.previousRank),
      weightPercent: finiteOrNull(signal.weightPercent),
      previousWeightPercent: finiteOrNull(signal.previousWeightPercent),
      message: stringOr(signal.message, ''),
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
    renderSelectedEtf();
    renderSignals();
  }

  function renderOverview() {
    const dashboard = state.dashboard;
    if (!dashboard) return;
    const latestDates = dashboard.etfs.map((etf) => etf.latest?.date).filter(Boolean).sort();
    const sourceWarnings = dashboard.etfs.filter((etf) => etf.latest?.sourceStatus && etf.latest.sourceStatus !== 'live').length;
    const totalSignals = dashboard.etfs.reduce((sum, etf) => sum + asArray(etf.latest?.signals).length, 0);
    renderMetricCards('#overview-metrics', [
      ['추적 ETF', `${dashboard.etfs.length}개`],
      ['최근 기준일', formatMaybeDate(latestDates.at(-1))],
      ['최근 특별 신호', `${totalSignals.toLocaleString('ko-KR')}건`],
      ['소스 경고', sourceWarnings ? `${sourceWarnings}개 ETF 확인 필요` : '정상'],
    ]);
    const status = $('#data-status');
    if (status) {
      const mode = dashboard.loadMode === 'fallback' ? 'fallback 표시 중' : '공개 JSON 로드 완료';
      status.textContent = `${mode} · 생성 ${formatFreshness(dashboard.generatedAt)} · ${dashboard.disclaimer || '투자 조언이 아닙니다.'}`;
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
    const height = 390;
    const margin = { top: 26, right: 28, bottom: 54, left: 68 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const maxValue = Math.max(...values, 1);
    const x = (date) => margin.left + ((Date.parse(date) - minDate) / Math.max(maxDate - minDate, 1)) * innerWidth;
    const y = (value) => margin.top + (1 - value / Math.max(maxValue * 1.12, 1)) * innerHeight;
    const ticks = buildTicks(0, Math.max(maxValue * 1.12, 1), 5);
    const grid = ticks.map((tick) => `<g><line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick)}" y2="${y(tick)}" stroke="#d9e2f1"/><text x="${margin.left - 10}" y="${y(tick) + 4}" text-anchor="end" fill="#667085" font-size="12">${formatWeight(tick)}</text></g>`).join('');
    const paths = series.map((item, index) => {
      const color = COLORS[index % COLORS.length];
      const valid = item.points.filter((point) => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.date)));
      const path = valid.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'} ${x(point.date).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
      const circles = valid.map((point) => `<circle cx="${x(point.date).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="3.4" fill="${color}"><title>${escapeHtml(item.label)} ${point.date}: ${formatWeight(point.value)}</title></circle>`).join('');
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${circles}`;
    }).join('');
    const legend = series.map((item, index) => `<span><i class="legend-key" style="background:${COLORS[index % COLORS.length]}"></i>${escapeHtml(item.label)}</span>`).join('');
    const firstDate = new Date(minDate).toISOString().slice(0, 10);
    const lastDate = new Date(maxDate).toISOString().slice(0, 10);
    target.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>
        ${grid}
        <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="#aab7cf"/>
        <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#aab7cf"/>
        <text x="${margin.left}" y="${height - 18}" fill="#667085" font-size="12">${escapeHtml(firstDate)}</text>
        <text x="${width - margin.right}" y="${height - 18}" text-anchor="end" fill="#667085" font-size="12">${escapeHtml(lastDate)}</text>
        <text x="${margin.left}" y="18" fill="#344054" font-size="13" font-weight="800">TOP10 비중(%)</text>
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
        const holding = snapshot.top10.find((row) => holdingKey(row) === key);
        return { date: snapshot.date, value: holding?.weightPercent ?? 0 };
      });
      return { key, label, points };
    }).filter((item) => item.points.some((point) => point.value > 0));
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
        holding.ticker ? badge(holding.ticker) : '가격 제외',
        formatWeight(holding.weightPercent),
        classificationBadge(decomp.classification || 'insufficient_data'),
        decomp.confidence || latest?.sourceConfidence || '-',
      ];
    }, 6);
  }

  function renderDecomposition(latest) {
    const rows = (latest?.decomposition || []).slice().sort((a, b) => {
      const severity = { new_entry: 0, exit: 0, likely_buy: 1, likely_sell: 1, mixed: 2, price_explained: 3, insufficient_data: 4 };
      return (severity[a.classification] ?? 9) - (severity[b.classification] ?? 9);
    });
    renderRows('#decomposition-rows', rows, (row) => [
      nameCell(row.name, row.ticker),
      formatWeight(row.previousWeightPercent),
      formatWeight(row.actualWeightPercent),
      formatPercentPoint(row.deltaPricePercentPoint),
      formatPercentPoint(row.deltaResidualPercentPoint),
      classificationBadge(row.classification),
    ], 6);
  }

  function renderSource(etf, latest, filteredHistory) {
    const target = $('#source-list');
    if (!target) return;
    const summary = latest?.analysisSummary || {};
    target.innerHTML = `
      <div class="source-item"><strong>${escapeHtml(etf.name)}</strong><span>${escapeHtml(etf.provider)} · ${escapeHtml(etf.code)}</span></div>
      <div class="source-item"><strong>기준일</strong><span>${escapeHtml(formatMaybeDate(latest?.date))} · 선택 범위 ${filteredHistory.length.toLocaleString('ko-KR')}개 스냅샷</span></div>
      <div class="source-item"><strong>소스 상태</strong><span class="${latest?.sourceStatus === 'live' ? '' : 'warning'}">${escapeHtml(latest?.sourceStatus || 'unknown')} · ${escapeHtml(latest?.sourceWarning || '정상')}</span></div>
      <div class="source-item"><strong>종가 커버리지</strong><span>${formatCoverage(summary.returnCoverage)} · ${escapeHtml(summary.returnCoverageStatus || 'insufficient')}</span></div>
    `;
    const pill = $('#coverage-pill');
    if (pill) {
      const warning = summary.returnCoverageStatus && summary.returnCoverageStatus !== 'ok';
      pill.classList.toggle('warning', Boolean(warning));
      pill.textContent = `종가 커버리지 ${formatCoverage(summary.returnCoverage)}`;
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

  function classificationBadge(value) {
    const span = document.createElement('span');
    const key = stringOr(value, 'insufficient_data');
    span.className = `classification ${escapeAttribute(key)}`;
    span.textContent = classLabel(key);
    return span;
  }

  function classLabel(value) {
    const labels = {
      price_explained: '가격 설명',
      likely_buy: '매수 가능성',
      likely_sell: '매도 가능성',
      mixed: '혼합/저신뢰',
      new_entry: 'TOP10 편입',
      top10_entry: 'TOP10 편입',
      exit: 'TOP10 편출',
      top10_exit: 'TOP10 편출',
      insufficient_data: '데이터 부족',
      signal: '신호',
    };
    return labels[value] || value;
  }

  function buildTicks(min, max, count) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return [];
    const step = (max - min) / (count - 1 || 1);
    return Array.from({ length: count }, (_, index) => min + step * index);
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

  function formatCoverage(value) {
    const num = finiteOrNull(value);
    if (num === null) return '-';
    return `${(num * 100).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}%`;
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
      filterHistory,
      buildWeightSeries,
      holdingKey,
      classLabel,
      formatWeight,
      formatCoverage,
      FALLBACK_DASHBOARD,
      QUANT_DASHBOARD_URL,
    };
  }
})();
