(() => {
  'use strict';

  const STORAGE_KEY = 'quant-calm-theme';
  const PROJECTS = [
    { id: 'hub', label: 'Hub', href: 'https://sonchanggi.github.io/quant-dashboard/' },
    { id: 'momentum', label: 'Momentum', href: 'https://sonchanggi.github.io/momentum-factor-lab/' },
    { id: 'dram', label: 'DRAM', href: 'https://sonchanggi.github.io/dram-price/' },
    { id: 'best', label: 'Best Factor', href: 'https://sonchanggi.github.io/best-factor/' },
    { id: 'etf', label: 'ETF', href: 'https://sonchanggi.github.io/etf-tracking/' },
    { id: 'sox', label: 'SOX', href: 'https://sonchanggi.github.io/sox/' },
    { id: 'risk-score', label: 'Risk Score', href: 'https://sonchanggi.github.io/quant-dashboard/risk-score/' },
    { id: 'port', label: 'Port', href: 'https://sonchanggi.github.io/port/' },
    { id: 'valuation', label: 'Valuation', href: 'https://sonchanggi.github.io/valuation/' },
  ];

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return null;
    }
  }

  function setStoredTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (_) {
      // Storage can be unavailable in restrictive preview contexts; the UI still works for this session.
    }
  }

  function preferredTheme() {
    const stored = getStoredTheme();
    if (stored === 'light' || stored === 'dark') return stored;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  }

  function applyTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      const isDark = next === 'dark';
      button.setAttribute('aria-pressed', String(isDark));
      button.textContent = isDark ? '라이트 모드' : '다크 모드';
      button.title = isDark ? '라이트 테마로 전환' : '다크 테마로 전환';
    });
  }

  function detectProjectId() {
    const declared = document.documentElement.dataset.projectId || document.body?.dataset.projectId;
    if (declared) return declared;
    const path = window.location.pathname.replace(/\/+$/, '/');
    if (path.includes('/momentum-factor-lab/')) return 'momentum';
    if (path.includes('/dram-price/')) return 'dram';
    if (path.includes('/best-factor/')) return 'best';
    if (path.includes('/etf-tracking/')) return 'etf';
    if (path.includes('/sox/')) return 'sox';
    if (path.includes('/risk-score/')) return 'risk-score';
    if (path.includes('/port/')) return 'port';
    if (path.includes('/valuation/')) return 'valuation';
    return 'hub';
  }

  function makeLink(project, activeId) {
    const link = document.createElement('a');
    link.href = project.href;
    link.className = 'quant-nav-link';
    link.dataset.navId = project.id;
    link.textContent = project.label;
    if (project.id === activeId) {
      link.classList.add('is-active');
      link.setAttribute('aria-current', 'page');
    }
    return link;
  }

  function renderNav() {
    const container = document.querySelector('[data-common-nav]') || document.querySelector('.top-nav');
    if (!container) return;
    const activeId = detectProjectId();
    const keepLocalNav = container.hasAttribute('data-keep-local-nav');
    const localChildren = keepLocalNav ? Array.from(container.childNodes) : [];
    container.classList.add('quant-common-nav');
    container.setAttribute('data-common-nav', '');
    container.setAttribute('aria-label', 'Quant 프로젝트 공통 이동');
    if (keepLocalNav) container.classList.add('has-local-nav');

    const navList = document.createElement('div');
    navList.className = 'quant-nav-scroll';
    navList.setAttribute('role', 'list');
    PROJECTS.forEach((project) => {
      const item = document.createElement('span');
      item.setAttribute('role', 'listitem');
      item.append(makeLink(project, activeId));
      navList.append(item);
    });

    const actions = document.createElement('div');
    actions.className = 'quant-nav-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'quant-theme-toggle';
    toggle.setAttribute('data-theme-toggle', '');
    toggle.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      setStoredTheme(next);
      applyTheme(next);
    });
    actions.append(toggle);

    const children = [navList, actions];
    if (localChildren.length) {
      const localWrap = document.createElement('div');
      localWrap.className = 'quant-local-links';
      localChildren.forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) child.classList.add('quant-local-link');
        localWrap.append(child);
      });
      children.push(localWrap);
    }
    container.replaceChildren(...children);
    applyTheme(document.documentElement.dataset.theme || preferredTheme());
  }

  applyTheme(preferredTheme());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderNav, { once: true });
  } else {
    renderNav();
  }

  window.QuantCalmUI = Object.freeze({ projects: PROJECTS.slice(), applyTheme });
})();
