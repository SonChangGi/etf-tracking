((root) => {
  'use strict';

  const SHARED_VERSION = 'quant-platform-frontend/0.1.0';
  const STATIC_RESULT_CONTRACT = 'etf-static-result/v1';
  const EXPECTED_SCHEMA_MAJOR = 1;
  const REQUIRED_SNAPSHOT_FILES = Object.freeze({
    dashboard: 'data/dashboard.json',
    status: 'data/status.json',
    historyManifest: 'data/history.json',
    automation: 'data/automation-status.json',
  });

  const canonicalProjectRegistry = Object.freeze([
    { id: 'hub', label: 'Hub', url: 'https://sonchanggi.github.io/quant-dashboard/' },
    { id: 'fear-greed', label: 'Fear & Greed', url: 'https://sonchanggi.github.io/fearNgreed/' },
    { id: 'momentum', label: 'Momentum', url: 'https://sonchanggi.github.io/momentum-factor-lab/' },
    { id: 'dram', label: 'DRAM', url: 'https://sonchanggi.github.io/dram-price/' },
    { id: 'best-factor', label: 'Best Factor', url: 'https://sonchanggi.github.io/best-factor/' },
    { id: 'etf', label: 'ETF', url: 'https://sonchanggi.github.io/etf-tracking/' },
    { id: 'sox', label: 'SOX', url: 'https://sonchanggi.github.io/sox/' },
    { id: 'port', label: 'Port', url: 'https://sonchanggi.github.io/port/' },
    { id: 'regime', label: 'Regime', url: 'https://sonchanggi.github.io/regime/' },
  ].map(Object.freeze));

  const etfControlManifest = deepFreeze({
    schemaVersion: 1,
    projectId: 'etf',
    inputSchemaVersion: 'etf-display/v1',
    configHashAlgorithm: 'not-applicable-static-snapshot',
    controls: [
      {
        id: 'theme',
        label: '화면 테마',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'light',
        defaultSource: 'saved-setting',
      },
      {
        id: 'project_navigation',
        label: '프로젝트 이동',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'etf',
        defaultSource: 'html-constant',
      },
      {
        id: 'in_page_navigation',
        label: '페이지 내부 이동',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: '#main-content',
        defaultSource: 'html-constant',
      },
      {
        id: 'provider_source_link',
        label: '공급자 원문 보기',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: '',
        defaultSource: 'current-result',
      },
      {
        id: 'etf_selection',
        label: 'ETF 선택',
        controlKind: 'result_selector',
        valueType: 'string',
        defaultValue: 'time-nasdaq100-active',
        defaultSource: 'current-result',
        resultIdentityKey: 'etf.id',
      },
      {
        id: 'chart_observation_date',
        label: '차트 관찰일',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: '',
        defaultSource: 'current-result',
      },
      {
        id: 'range_start',
        label: '차트 표시 시작일',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: '',
        defaultSource: 'current-result',
      },
      {
        id: 'range_end',
        label: '결과 기준 종료일',
        controlKind: 'result_selector',
        valueType: 'string',
        defaultValue: '',
        defaultSource: 'current-result',
        resultIdentityKey: 'history.date',
      },
      {
        id: 'range_preset',
        label: '차트 표시 기간 프리셋',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'recent_31_days',
        defaultSource: 'html-constant',
      },
      {
        id: 'chart_series_focus',
        label: '차트 강조 종목',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: '',
        defaultSource: 'current-result',
      },
      {
        id: 'signal_bucket',
        label: '신호 유형 필터',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'signal',
        defaultSource: 'html-constant',
      },
      {
        id: 'signal_query',
        label: '종목 검색',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: '',
        defaultSource: 'html-constant',
      },
      {
        id: 'signal_rank_scope',
        label: '순위 범위 필터',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'all',
        defaultSource: 'html-constant',
      },
      {
        id: 'signal_magnitude',
        label: '변화 크기 필터',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'all',
        defaultSource: 'html-constant',
      },
      {
        id: 'signal_sort',
        label: '신호 정렬',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'recent',
        defaultSource: 'html-constant',
      },
      {
        id: 'signal_row_limit',
        label: '표시 신호 수',
        controlKind: 'display',
        valueType: 'number',
        defaultValue: 30,
        defaultSource: 'html-constant',
        minimum: 30,
        step: 30,
      },
      {
        id: 'signal_filter_reset',
        label: '신호 필터 초기화',
        controlKind: 'display',
        valueType: 'boolean',
        defaultValue: false,
        defaultSource: 'html-constant',
      },
      {
        id: 'history_load',
        label: '저장 히스토리 불러오기',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'lazy',
        defaultSource: 'html-constant',
      },
      {
        id: 'detail_disclosures',
        label: '상세 영역 열기',
        controlKind: 'display',
        valueType: 'boolean',
        defaultValue: false,
        defaultSource: 'html-constant',
      },
      {
        id: 'workflow_status',
        label: '워크플로 상태 보기',
        controlKind: 'display',
        valueType: 'string',
        defaultValue: 'update-data.yml',
        defaultSource: 'html-constant',
      },
      {
        id: 'owner_refresh_backfill',
        label: '소유자 갱신·백필',
        controlKind: 'operation',
        valueType: 'string',
        defaultValue: 'missing_only',
        defaultSource: 'html-constant',
        operationKey: 'github-actions:update-data.yml',
        requiresAuthentication: true,
      },
    ],
  });

  const canonicalTokenAliases = Object.freeze({
    background: '--qr-bg',
    surface: '--qr-surface',
    surfaceRaised: '--qr-surface-raised',
    surfaceSoft: '--qr-surface-soft',
    text: '--qr-text',
    textStrong: '--qr-text-strong',
    textMuted: '--qr-text-muted',
    textMutedStrong: '--qr-text-muted-strong',
    border: '--qr-border',
    borderStrong: '--qr-border-strong',
    primary: '--qr-primary',
    primaryStrong: '--qr-primary-strong',
    primarySoft: '--qr-primary-soft',
    positive: '--qr-positive',
    warning: '--qr-warning',
    negative: '--qr-negative',
    chartGrid: '--qr-chart-grid',
    chartAxis: '--qr-chart-axis',
    chartText: '--qr-chart-text',
  });

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  function record(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${path} 구조가 객체가 아닙니다.`);
    }
    return value;
  }

  function nonEmptyString(value, path) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`${path} 문자열이 없습니다.`);
    }
    return value;
  }

  function dateString(value, path) {
    const result = nonEmptyString(value, path);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
      throw new TypeError(`${path} 날짜 형식이 올바르지 않습니다.`);
    }
    return result;
  }

  function positiveInteger(value, path) {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`${path} 값이 양의 정수가 아닙니다.`);
    }
    return value;
  }

  function array(value, path) {
    if (!Array.isArray(value)) throw new TypeError(`${path} 배열이 없습니다.`);
    return value;
  }

  function schemaMajor(value, path) {
    const version = nonEmptyString(value, path);
    const match = /^(\d+)(?:\.\d+){0,2}$/.exec(version);
    if (!match) throw new TypeError(`${path} 버전 형식이 올바르지 않습니다.`);
    return Number(match[1]);
  }

  function assertControlManifest() {
    if (
      etfControlManifest.schemaVersion !== 1 ||
      etfControlManifest.projectId !== 'etf' ||
      etfControlManifest.inputSchemaVersion !== 'etf-display/v1'
    ) {
      throw new Error('ETF control manifest identity가 올바르지 않습니다.');
    }
    const ids = new Set();
    const operations = [];
    for (const control of etfControlManifest.controls) {
      if (!/^[a-z][a-z0-9_]*$/.test(control.id) || ids.has(control.id)) {
        throw new Error(`ETF control id가 유효하지 않거나 중복됩니다: ${control.id}`);
      }
      ids.add(control.id);
      if (control.controlKind === 'analysis') {
        throw new Error(`ETF는 analysis control을 노출할 수 없습니다: ${control.id}`);
      }
      if (!['display', 'result_selector', 'operation'].includes(control.controlKind)) {
        throw new Error(`ETF control kind를 지원하지 않습니다: ${control.controlKind}`);
      }
      if (control.controlKind === 'operation') operations.push(control);
    }
    if (
      operations.length !== 1 ||
      operations[0].id !== 'owner_refresh_backfill' ||
      operations[0].requiresAuthentication !== true
    ) {
      throw new Error('ETF 소유자 갱신·백필 operation 경계가 올바르지 않습니다.');
    }
  }

  function getCanonicalNavigation(currentId) {
    if (!canonicalProjectRegistry.some((project) => project.id === currentId)) {
      throw new RangeError(`알 수 없는 프로젝트 id입니다: ${currentId}`);
    }
    return canonicalProjectRegistry.map((project) => ({
      ...project,
      current: project.id === currentId,
    }));
  }

  function assertCanonicalNavigation(container, currentId = 'etf') {
    if (!container || typeof container.querySelectorAll !== 'function') {
      throw new TypeError('공통 프로젝트 메뉴 컨테이너가 없습니다.');
    }
    const expected = getCanonicalNavigation(currentId).filter((project) => project.id !== 'hub');
    const links = [...container.querySelectorAll('a')];
    if (links.length !== expected.length) {
      throw new Error(`공통 프로젝트 메뉴 수가 다릅니다: ${links.length}/${expected.length}`);
    }
    links.forEach((link, index) => {
      const item = expected[index];
      if (
        link.textContent.trim() !== item.label ||
        link.href !== item.url ||
        (link.getAttribute('aria-current') === 'page') !== item.current
      ) {
        throw new Error(`공통 프로젝트 메뉴가 레지스트리와 다릅니다: ${item.id}`);
      }
    });
  }

  function assertControlAnnotations(container) {
    if (!container || typeof container.querySelectorAll !== 'function') {
      throw new TypeError('ETF 화면 컨테이너가 없습니다.');
    }
    const controls = new Map(
      etfControlManifest.controls.map((control) => [control.id, control]),
    );
    const interactive = [
      ...container.querySelectorAll('a, button, input, select, summary'),
    ];
    for (const element of interactive) {
      const controlId = element.dataset?.controlId;
      const control = controls.get(controlId);
      if (!control) {
        throw new Error(
          `등록되지 않은 ETF 화면 control입니다: ${element.id || element.tagName}`,
        );
      }
      if (
        control.controlKind === 'operation' &&
        !['manual-update-link', 'copy-update-command'].includes(element.id)
      ) {
        throw new Error(`operation control annotation 위치가 올바르지 않습니다: ${element.id}`);
      }
    }
    return interactive.length;
  }

  function indexById(rows, path) {
    const result = new Map();
    array(rows, path).forEach((row, index) => {
      const item = record(row, `${path}[${index}]`);
      const id = nonEmptyString(item.id, `${path}[${index}].id`);
      if (result.has(id)) throw new Error(`${path}에 ETF id가 중복됩니다: ${id}`);
      result.set(id, item);
    });
    return result;
  }

  function matchingSet(left, right, label) {
    if (
      left.size !== right.size ||
      [...left.keys()].some((key) => !right.has(key))
    ) {
      throw new Error(`${label} ETF 목록이 일치하지 않습니다.`);
    }
  }

  function validateEnvelope(payload, path) {
    const item = record(payload, path);
    if (schemaMajor(item.schemaVersion, `${path}.schemaVersion`) !== EXPECTED_SCHEMA_MAJOR) {
      throw new Error(`${path} schema major를 지원하지 않습니다.`);
    }
    return {
      payload: item,
      schemaVersion: item.schemaVersion,
      generatedAt: nonEmptyString(item.generatedAt, `${path}.generatedAt`),
    };
  }

  /**
   * Validates the small published snapshot files without recalculating,
   * normalizing, sorting, or embedding the large per-ETF histories.
   */
  function adaptEtfStaticResultV1(payloads) {
    const input = record(payloads, 'payloads');
    const dashboardEnvelope = validateEnvelope(input.dashboard, 'dashboard');
    const statusEnvelope = validateEnvelope(input.status, 'status');
    const historyEnvelope = validateEnvelope(input.historyManifest, 'historyManifest');
    const automationEnvelope = validateEnvelope(input.automation, 'automation');
    const envelopes = [
      statusEnvelope,
      historyEnvelope,
      automationEnvelope,
    ];
    for (const envelope of envelopes) {
      if (envelope.schemaVersion !== dashboardEnvelope.schemaVersion) {
        throw new Error('ETF snapshot schemaVersion이 파일 사이에서 일치하지 않습니다.');
      }
      if (envelope.generatedAt !== dashboardEnvelope.generatedAt) {
        throw new Error('ETF snapshot generatedAt이 파일 사이에서 일치하지 않습니다.');
      }
    }

    const dashboardEtfs = indexById(dashboardEnvelope.payload.etfs, 'dashboard.etfs');
    const statusEtfs = indexById(statusEnvelope.payload.etfs, 'status.etfs');
    const historyEtfs = indexById(historyEnvelope.payload.etfs, 'historyManifest.etfs');
    if (dashboardEtfs.size !== 3) {
      throw new Error(`ETF snapshot은 추적 ETF 3종이어야 합니다: ${dashboardEtfs.size}`);
    }
    matchingSet(dashboardEtfs, statusEtfs, 'dashboard/status');
    matchingSet(dashboardEtfs, historyEtfs, 'dashboard/historyManifest');

    const expectedHistories = {};
    for (const [id, dashboardEtf] of dashboardEtfs) {
      if (Array.isArray(dashboardEtf.history)) {
        throw new Error(`dashboard.json에 대용량 history가 포함되었습니다: ${id}`);
      }
      const statusEtf = statusEtfs.get(id);
      const historyEtf = historyEtfs.get(id);
      const expectedUrl = `data/history/${id}.json`;
      const historyUrl = nonEmptyString(dashboardEtf.historyUrl, `dashboard.etfs.${id}.historyUrl`);
      if (
        historyUrl !== expectedUrl ||
        historyEtf.historyUrl !== expectedUrl
      ) {
        throw new Error(`ETF history 경로가 정적 계약과 다릅니다: ${id}`);
      }
      const historyCount = positiveInteger(
        dashboardEtf.historyCount,
        `dashboard.etfs.${id}.historyCount`,
      );
      if (historyEtf.historyCount !== historyCount) {
        throw new Error(`ETF historyCount가 manifest와 다릅니다: ${id}`);
      }
      const startDate = dateString(
        dashboardEtf.availableStartDate,
        `dashboard.etfs.${id}.availableStartDate`,
      );
      const endDate = dateString(
        dashboardEtf.availableEndDate,
        `dashboard.etfs.${id}.availableEndDate`,
      );
      if (
        historyEtf.availableStartDate !== startDate ||
        historyEtf.availableEndDate !== endDate
      ) {
        throw new Error(`ETF history 날짜 범위가 manifest와 다릅니다: ${id}`);
      }
      const latest = record(dashboardEtf.latest, `dashboard.etfs.${id}.latest`);
      if (
        dateString(latest.date, `dashboard.etfs.${id}.latest.date`) !== endDate ||
        statusEtf.latestDate !== endDate
      ) {
        throw new Error(`ETF 최신 기준일이 status/history와 다릅니다: ${id}`);
      }
      if (!array(latest.top10, `dashboard.etfs.${id}.latest.top10`).length) {
        throw new Error(`ETF 최신 TOP10 결과가 없습니다: ${id}`);
      }
      expectedHistories[id] = Object.freeze({
        id,
        historyUrl,
        historyCount,
        startDate,
        endDate,
      });
    }

    const dataAsOf = dateString(
      historyEnvelope.payload.availableEndDate,
      'historyManifest.availableEndDate',
    );
    if (
      dataAsOf !==
      [...Object.values(expectedHistories)].map((item) => item.endDate).sort().at(-1)
    ) {
      throw new Error('ETF history manifest 기준일이 ETF 최신일과 다릅니다.');
    }
    const statusTargetDate = dateString(
      statusEnvelope.payload.targetDate,
      'status.targetDate',
    );
    const automationTargetDate = dateString(
      automationEnvelope.payload.targetDate,
      'automation.targetDate',
    );
    if (
      statusTargetDate !== automationTargetDate ||
      statusTargetDate < dataAsOf
    ) {
      throw new Error('ETF status/automation targetDate identity가 일치하지 않습니다.');
    }

    const resultKey = `${dashboardEnvelope.generatedAt}|${dataAsOf}|${Object.values(
      expectedHistories,
    )
      .map((item) => `${item.id}:${item.historyCount}`)
      .sort()
      .join(',')}`;

    return {
      identity: Object.freeze({
        projectId: 'etf',
        contractVersion: STATIC_RESULT_CONTRACT,
        sharedVersion: SHARED_VERSION,
        schemaVersion: dashboardEnvelope.schemaVersion,
        generatedAt: dashboardEnvelope.generatedAt,
        dataAsOf,
        resultKey,
        sourceFiles: Object.freeze(Object.values(REQUIRED_SNAPSHOT_FILES)),
        expectedHistories: deepFreeze(expectedHistories),
      }),
      data: {
        dashboard: input.dashboard,
        status: input.status,
        historyManifest: input.historyManifest,
        automation: input.automation,
      },
    };
  }

  function adaptEtfHistoryV1(payload, snapshotIdentity, etfId) {
    const identity = record(snapshotIdentity, 'snapshotIdentity');
    if (
      identity.projectId !== 'etf' ||
      identity.contractVersion !== STATIC_RESULT_CONTRACT
    ) {
      throw new Error('검증된 ETF snapshot identity가 아닙니다.');
    }
    const expected = record(
      record(identity.expectedHistories, 'snapshotIdentity.expectedHistories')[etfId],
      `snapshotIdentity.expectedHistories.${etfId}`,
    );
    const envelope = validateEnvelope(payload, `history.${etfId}`);
    if (
      envelope.generatedAt !== identity.generatedAt ||
      envelope.schemaVersion !== identity.schemaVersion
    ) {
      throw new Error(`ETF history가 선택 snapshot과 일치하지 않습니다: ${etfId}`);
    }
    const history = array(envelope.payload.history, `history.${etfId}.history`);
    if (
      envelope.payload.id !== etfId ||
      envelope.payload.historyCount !== expected.historyCount ||
      history.length !== expected.historyCount
    ) {
      throw new Error(`ETF history identity/count가 다릅니다: ${etfId}`);
    }
    let previousDate = '';
    history.forEach((row, index) => {
      const date = dateString(
        record(row, `history.${etfId}.history[${index}]`).date,
        `history.${etfId}.history[${index}].date`,
      );
      if (previousDate && date < previousDate) {
        throw new Error(`ETF history 날짜 순서가 뒤집혔습니다: ${etfId}`);
      }
      previousDate = date;
    });
    if (
      history[0]?.date !== expected.startDate ||
      history.at(-1)?.date !== expected.endDate ||
      envelope.payload.availableStartDate !== expected.startDate ||
      envelope.payload.availableEndDate !== expected.endDate ||
      envelope.payload.latest?.date !== expected.endDate
    ) {
      throw new Error(`ETF history 날짜 범위가 snapshot과 다릅니다: ${etfId}`);
    }
    return {
      identity: Object.freeze({
        ...expected,
        projectId: 'etf',
        contractVersion: STATIC_RESULT_CONTRACT,
        generatedAt: identity.generatedAt,
      }),
      data: payload,
    };
  }

  function resolveSameOrigin(path, baseUrl) {
    const base = new URL(nonEmptyString(baseUrl, 'baseUrl'));
    const resolved = new URL(nonEmptyString(path, 'path'), base);
    if (!['http:', 'https:'].includes(resolved.protocol) || resolved.origin !== base.origin) {
      throw new Error(`same-origin 정적 경로가 아닙니다: ${path}`);
    }
    return resolved;
  }

  async function fetchJsonSameOrigin(path, options = {}) {
    const baseUrl =
      options.baseUrl ||
      root.document?.baseURI ||
      root.location?.href;
    const fetchImpl = options.fetchImpl || root.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('정적 JSON fetch 구현이 없습니다.');
    }
    const url = resolveSameOrigin(path, baseUrl);
    const controller =
      typeof root.AbortController === 'function'
        ? new root.AbortController()
        : null;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : 20_000;
    const timer =
      controller && typeof root.setTimeout === 'function'
        ? root.setTimeout(() => controller.abort(), timeoutMs)
        : null;
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        method: 'GET',
        signal: controller?.signal,
      });
      if (!response?.ok) {
        throw new Error(`${path} HTTP ${response?.status ?? 'unknown'}`);
      }
      return await response.json();
    } finally {
      if (timer !== null && typeof root.clearTimeout === 'function') {
        root.clearTimeout(timer);
      }
    }
  }

  async function loadEtfStaticSnapshotV1(options = {}) {
    const entries = await Promise.all(
      Object.entries(REQUIRED_SNAPSHOT_FILES).map(async ([key, path]) => [
        key,
        await fetchJsonSameOrigin(path, options),
      ]),
    );
    return adaptEtfStaticResultV1(Object.fromEntries(entries));
  }

  async function loadEtfHistoryV1(snapshotIdentity, etfId, options = {}) {
    const expected = record(
      record(snapshotIdentity, 'snapshotIdentity').expectedHistories?.[etfId],
      `snapshotIdentity.expectedHistories.${etfId}`,
    );
    const payload = await fetchJsonSameOrigin(expected.historyUrl, options);
    return adaptEtfHistoryV1(payload, snapshotIdentity, etfId);
  }

  assertControlManifest();

  root.__ETF_SHARED_PLATFORM__ = Object.freeze({
    SHARED_VERSION,
    STATIC_RESULT_CONTRACT,
    REQUIRED_SNAPSHOT_FILES,
    canonicalProjectRegistry,
    canonicalTokenAliases,
    etfControlManifest,
    assertControlManifest,
    getCanonicalNavigation,
    assertCanonicalNavigation,
    assertControlAnnotations,
    adaptEtfStaticResultV1,
    adaptEtfHistoryV1,
    resolveSameOrigin,
    fetchJsonSameOrigin,
    loadEtfStaticSnapshotV1,
    loadEtfHistoryV1,
  });
})(globalThis);
