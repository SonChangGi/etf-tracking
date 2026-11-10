const numericTypes = new Set(['number', 'percent', 'bar']);
const missing = value => value == null || (typeof value === 'number' && !Number.isFinite(value));
const numberValue = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Stable, immutable sort. Missing or invalid numeric observations always stay last. */
export function sortRows(rows, column, direction = 'asc') {
  const key = typeof column === 'string' ? column : column.key;
  const numeric = typeof column === 'object' && numericTypes.has(column.type);
  const sign = direction === 'desc' ? -1 : 1;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const x = numeric ? numberValue(a.row[key]) : a.row[key];
    const y = numeric ? numberValue(b.row[key]) : b.row[key];
    if (missing(x) || missing(y)) return missing(x) === missing(y) ? a.index - b.index : missing(x) ? 1 : -1;
    const order = numeric ? x - y : String(x).localeCompare(String(y), 'ko', { numeric: true });
    return order === 0 ? a.index - b.index : sign * order;
  }).map(item => item.row);
}

export function filterRows(rows, query = '', columns) {
  const words = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const keys = columns?.map(column => typeof column === 'string' ? column : column.key);
  return rows.filter(row => words.every(word => (keys ? keys.map(key => row[key]) : Object.values(row))
    .some(value => !missing(value) && String(value).toLocaleLowerCase().includes(word))));
}

/** Inclusive numeric range; absence is not zero and reversed bounds are rejected. */
export function filterNumericRows(rows, key, min = null, max = null) {
  if (!key || (min == null && max == null)) return rows.slice();
  if ((min != null && !Number.isFinite(min)) || (max != null && !Number.isFinite(max))) throw new TypeError('범위에는 유한한 숫자를 입력하세요.');
  if (min != null && max != null && min > max) throw new TypeError('최솟값은 최댓값보다 클 수 없습니다.');
  return rows.filter(row => { const value = numberValue(row[key]); return value != null && (min == null || value >= min) && (max == null || value <= max); });
}

/** Full-column scales remain stable across filtering, pagination and sorting. */
export function columnExtent(rows, column) {
  let low = Infinity, high = -Infinity;
  for (const row of rows) {
    const values = column.type === 'sparkline' ? (Array.isArray(row[column.key]) ? row[column.key] : []) : [row[column.key]];
    for (const value of values) if (numberValue(value) != null) { low = Math.min(low,value); high = Math.max(high,value); }
  }
  return low === Infinity ? [0,0] : [low,high];
}

/** Text is protected from spreadsheet formula execution; numeric negatives remain numbers. */
export function toCSV(rows, columns) {
  const cell = value => {
    if (missing(value)) return '""';
    if (typeof value === 'number') return String(value);
    let text = Array.isArray(value) ? value.map(v => missing(v) ? '' : v).join(';') : String(value);
    if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [columns.map(column => cell(column.label ?? column.key)).join(','),
    ...rows.map(row => columns.map(column => cell(row[column.key])).join(','))].join('\r\n');
}

let nextId = 0;
export function mountTable(element, initialSpec, { onSelect } = {}) {
  if (!element?.ownerDocument) throw new TypeError('mountTable requires a DOM element');
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  let spec, destroyed = false, observer, selectedId = null, query = '', compact = false;
  let pageIndex = 0, pageSize = 20, pageRows = [], numericFilter = null, extents = new Map(), ranks = new Map(), rankColumn = null;
  let sort = null, theme = '', visibleKeys = new Set(), currentRows = [], urlTimers = new Set();
  const prefix = `qe-table-${++nextId}`;
  const root = node('section', 'qe-table');
  const toolbar = node('div', 'qe-table-toolbar');
  const title = node('h2', 'qe-table-title');
  title.id = `${prefix}-title`;
  root.setAttribute('aria-labelledby', title.id);
  const controls = node('div', 'qe-table-controls');
  const searchLabel = node('label', 'qe-table-search');
  searchLabel.append(node('span', '', '검색'));
  const search = node('input');
  search.type = 'search'; search.placeholder = '표 안에서 검색';
  searchLabel.append(search);
  const chooser = node('details', 'qe-table-chooser');
  chooser.append(node('summary', '', '표시 열'));
  const columnChoices = node('div', 'qe-table-choices');
  chooser.append(columnChoices);
  const density = button('행 간격 줄이기');
  density.setAttribute('aria-pressed', 'false');
  const download = button('CSV 저장');
  const range = node('details', 'qe-table-range');
  range.append(node('summary', '', '숫자 범위'));
  const rangeControls = node('div', 'qe-table-range-controls');
  const rangeColumn = node('select'); rangeColumn.setAttribute('aria-label', '범위 필터 열');
  const rangeMin = node('input'); rangeMin.type = 'number'; rangeMin.step = 'any'; rangeMin.placeholder = '최솟값'; rangeMin.setAttribute('aria-label', '범위 최솟값');
  const rangeMax = node('input'); rangeMax.type = 'number'; rangeMax.step = 'any'; rangeMax.placeholder = '최댓값'; rangeMax.setAttribute('aria-label', '범위 최댓값');
  const rangeApply = button('범위 적용'), rangeClear = button('범위 해제');
  const rangeError = node('p', 'qe-table-range-error'); rangeError.setAttribute('role', 'alert');
  rangeError.id = `${prefix}-range-error`; rangeMin.setAttribute('aria-describedby', rangeError.id); rangeMax.setAttribute('aria-describedby', rangeError.id);
  rangeControls.append(rangeColumn, rangeMin, rangeMax, rangeApply, rangeClear, rangeError); range.append(rangeControls);
  const resetFilters=button('필터 해제');resetFilters.className='qe-reset-filters';
  const tools=node('details','qe-table-tools');const toolsTitle=node('summary','','표 도구');const toolsBody=node('div','qe-table-tools-body');tools.append(toolsTitle,toolsBody);toolsBody.append(chooser,range,density,download);tools.addEventListener('keydown',e=>{if(e.key==='Escape'&&e.target===toolsTitle){tools.open=false;toolsTitle.focus();}});controls.append(searchLabel,tools,resetFilters);
  toolbar.append(title, controls);
  const count = node('p', 'qe-table-count');
  count.setAttribute('role', 'status');
  const frame = node('div', 'qe-table-frame');
  const scroll = node('div', 'qe-table-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', '표 가로 탐색');
  const table = node('table');
  const caption = node('caption');
  const head = node('thead');
  const body = node('tbody');
  table.append(caption, head, body); scroll.append(table); frame.append(scroll);
  const empty = node('div', 'qe-table-empty');
  const emptyText = node('p');
  const clear = button('필터 해제');
  empty.append(emptyText, clear);
  const hint = node('p', 'qe-table-hint', '좌우로 이동해 다른 열을 확인하세요.');
  const pager = node('nav', 'qe-table-pager'); pager.setAttribute('aria-label', '표 페이지');
  const previous = button('이전'), next = button('다음'), pageText = node('span');
  pageText.setAttribute('aria-live','polite'); pager.append(previous, pageText, next);
  const scaleNote = node('p', 'qe-table-scale-note');
  const scaleDetails=node('details','qe-table-method');scaleDetails.append(node('summary','','척도·순위 기준'),scaleNote);
  root.append(toolbar, count, hint, frame, empty, pager, scaleDetails); element.append(root);

  function node(tag, className = '', text) {
    const value = doc.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  }
  function button(text) {
    const value = node('button', '', text); value.type = 'button'; return value;
  }
  function edges() {
    if (destroyed) return;
    const overflow = scroll.scrollWidth > scroll.clientWidth + 1;
    frame.classList.toggle('qe-edge-left', overflow && scroll.scrollLeft > 1);
    frame.classList.toggle('qe-edge-right', overflow && scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 1);
    hint.hidden = true;scroll.title=overflow?'좌우로 이동해 다른 열 보기':'';
  }
  function columns() { return spec.columns.filter(column => visibleKeys.has(column.key)); }
  function display(value, column) {
    if (missing(value)) return '—';
    if (numericTypes.has(column.type)) {
      const n = numberValue(value);
      if (n == null) return '—';
      const valueText = new Intl.NumberFormat('ko-KR', n!==0 && Math.abs(n)<.01 ? {maximumSignificantDigits:3} : { maximumFractionDigits: 2 }).format(n);
      // Percent values are already in display units: 12.5 means 12.5%, never 0.125.
      return valueText + (column.type === 'percent' ? (column.unit || '%') : '');
    }
    return String(value);
  }
  function select(row) {
    selectedId = row.id;
    for (const tr of body.querySelectorAll('tr[data-qe-row]')) {
      const active = tr.dataset.qeRow === String(row.id);
      tr.classList.toggle('qe-selected', active);
      if (onSelect) tr.setAttribute('aria-selected', String(active));
    }
    onSelect?.(row);
  }
  function sparkline(value, column) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 104 30'); svg.classList.add('qe-table-sparkline');
    svg.setAttribute('role', 'img');
    const values = Array.isArray(value) ? value : [];
    const valid = values.filter(v => numberValue(v) != null);
    svg.setAttribute('aria-label', valid.length ? `추이 ${values.map(v => numberValue(v) == null ? '누락' : display(v,{type:'number'})).join(', ')}` : '관측 없음');
    if (!valid.length) return node('span', '', '—');
    const [min,max] = extents.get(column.key) || [0,0], span = max - min;
    svg.dataset.domain = `${min},${max}`;
    let open = false;
    const d = values.map((v, i) => {
      if (numberValue(v) == null) { open = false; return ''; }
      const x = values.length === 1 ? 52 : 2 + i / (values.length - 1) * 100;
      const y = span ? 27 - (v - min) / span * 24 : 15;
      const part = `${open ? 'L' : 'M'}${x},${y}`; open = true; return part;
    }).join(' ');
    const path = doc.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d); svg.append(path);
    // Single observations are still visible; nulls never connect adjacent runs.
    values.forEach((v, i) => {
      if (numberValue(v) == null) return;
      const dot = doc.createElementNS(svg.namespaceURI, 'circle');
      dot.setAttribute('cx', values.length === 1 ? '52' : String(2 + i / (values.length - 1) * 100));
      dot.setAttribute('cy', String(span ? 27 - (v - min) / span * 24 : 15));
      dot.setAttribute('r', '1.5'); svg.append(dot);
    });
    return svg;
  }
  function makeCell(row, column, first) {
    const cell = node(first ? 'th' : 'td');
    if (first) cell.scope = 'row';
    if (numericTypes.has(column.type)) cell.classList.add('qe-numeric');
    const value = row[column.key];
    if (column.type === 'sparkline') cell.append(sparkline(value, column));
    else if (column.type === 'bar' && numberValue(value) != null) {
      const wrap = node('div', 'qe-table-bar');
      const track = node('span', 'qe-table-bar-track'); track.setAttribute('aria-hidden', 'true');
      const fill = node('span', value < 0 ? 'qe-negative' : 'qe-positive');
      const domain = extents.get(column.key) || [0,0];
      const low = Math.min(0, domain[0]), high = Math.max(0, domain[1]), span = high - low || 1;
      const zero = -low / span * 100;
      track.dataset.domain = `${low},${high}`;
      fill.style.left = `${(Math.min(0,value)-low)/span*100}%`;
      fill.style.width = `${Math.abs(value)/span*100}%`;
      const baseline = node('i', 'qe-table-bar-zero'); baseline.style.left = `${zero}%`;
      track.append(fill,baseline); wrap.append(track, node('span', '', display(value, column))); cell.append(wrap);
    } else cell.textContent = display(value, column);
    if (first && spec.variant === 'ranked') {
      const rank = ranks.get(row.id), badge=node('span','qe-table-rank',rank??'—');
      badge.setAttribute('aria-label', rank==null?'순위 미제공':`전체 자료 순위 ${rank}`);
      if(rank===1)badge.classList.add('qe-rank-first');cell.prepend(badge);
    }
    if (spec.variant === 'matrix' && numericTypes.has(column.type) && numberValue(value) != null) {
      const domain = extents.get(column.key) || [0,0], max = Math.max(Math.abs(domain[0]),Math.abs(domain[1]));
      const strength = max ? Math.abs(value)/max : 0;
      cell.classList.add('qe-heat-cell'); cell.dataset.heat = String(value < 0 ? -strength : strength);
      cell.style.setProperty('--qe-heat-color', value < 0 ? 'var(--qe-negative)' : 'var(--qe-accent)');
      cell.style.setProperty('--qe-heat-strength', `${Math.round(strength*22)}%`);
      cell.title = `${display(value,column)} · 열 공통 색 범위 ${-max} ~ ${max}`;
    }
    return cell;
  }
  function render() {
    if (destroyed) return;
    const cols = columns();
    title.textContent = spec.title || '데이터 표';
    caption.textContent = spec.caption || spec.title || '데이터 표';
    root.dataset.variant = spec.variant || 'standard';
    root.classList.toggle('qe-compact', compact);
    density.textContent = compact ? '행 간격 늘리기' : '행 간격 줄이기';
    density.setAttribute('aria-pressed', String(compact));
    currentRows = filterRows(spec.rows, query, spec.columns);
    if (numericFilter) currentRows = filterNumericRows(currentRows, numericFilter.key, numericFilter.min, numericFilter.max);
    if (sort) currentRows = sortRows(currentRows, spec.columns.find(c => c.key === sort.key), sort.direction);
    const pages = Math.max(1, Math.ceil(currentRows.length / pageSize));
    pageIndex = Math.min(pageIndex,pages-1);
    pageRows = currentRows.slice(pageIndex*pageSize,(pageIndex+1)*pageSize);
    const rangeLabel = numericFilter ? ` · ${spec.columns.find(c=>c.key===numericFilter.key)?.label}: ${numericFilter.min??'제한 없음'} ~ ${numericFilter.max??'제한 없음'}` : '';
    count.textContent = `${currentRows.length} / ${spec.rows.length}개 행${currentRows.length>pageSize?` · ${pageIndex*pageSize+1}–${pageIndex*pageSize+pageRows.length} 표시`:''}${rangeLabel}`;
    pager.hidden = currentRows.length <= pageSize; previous.disabled = pageIndex===0; next.disabled = pageIndex===pages-1;
    pageText.textContent = `${pageIndex+1} / ${pages} 페이지`;
    download.title = `현재 필터·정렬의 전체 ${currentRows.length}개 행과 표시 열 저장`;
    scaleNote.textContent = [spec.variant==='ranked'&&rankColumn?`순위: 전체 자료의 ${rankColumn.label} ${spec.rankDirection==='asc'?'오름차순':'내림차순'} · 동률은 같은 순위. 검색·정렬에도 순위 기준을 유지합니다.`:'',cols.some(c=>c.type==='sparkline')?'흐름: 같은 열의 전체 자료 기준 공통 y축. 위치는 배열 순서이며 달력 간격을 뜻하지 않습니다.':'', spec.variant==='matrix'?'셀 색: 열별 0 중심 대칭 범위. 색이 달라도 서로 다른 열의 단위는 직접 비교하지 않습니다.':''].filter(Boolean).join(' ');
    scaleDetails.hidden = !scaleNote.textContent;
    head.replaceChildren(); body.replaceChildren();
    if (spec.variant === 'matrix' && cols.some(c => c.group)) {
      const groups = node('tr', 'qe-table-column-groups');
      for (let i = 0; i < cols.length;) {
        let end = i + 1;
        while (end < cols.length && cols[end].group === cols[i].group) end++;
        const cell = node('th', '', cols[i].group || '항목');
        cell.scope = 'colgroup'; cell.colSpan = end - i; groups.append(cell); i = end;
      }
      head.append(groups);
    }
    const headers = node('tr');
    cols.forEach(column => {
      const cell = node('th'); cell.scope = 'col';
      if (numericTypes.has(column.type)) cell.classList.add('qe-numeric');
      const label = column.label + (column.unit ? ` (${column.unit})` : column.type === 'percent' ? ' (%)' : '');
      if (column.type !== 'sparkline') {
        const active = sort?.key === column.key;
        cell.setAttribute('aria-sort', active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
        const control = button(label + (active ? sort.direction === 'asc' ? ' ↑' : ' ↓' : ' ↕'));
        control.setAttribute('aria-label', `${column.label} ${active && sort.direction === 'asc' ? '내림차순' : '오름차순'} 정렬`);
        control.onclick = () => {
          pageIndex = 0;
          sort = { key: column.key, direction: active && sort.direction === 'asc' ? 'desc' : 'asc' };
          render();
          [...head.querySelectorAll('button')].find(b => b.dataset.key === column.key)?.focus();
        };
        control.dataset.key = column.key; cell.append(control);
      } else cell.textContent = label;
      headers.append(cell);
    });
    head.append(headers);
    const grouped = spec.variant === 'grouped' && spec.rowGroup;
    const batches = new Map();
    for (const row of pageRows) {
      const key = grouped ? String(row[spec.rowGroup] ?? '미분류') : '';
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(row);
    }
    for (const [group, rows] of batches) {
      if (grouped) {
        const tr = node('tr', 'qe-table-group');
        const cell = node('th', '', `${group} · 이 페이지 ${rows.length}개`);
        cell.colSpan = cols.length; cell.scope = 'row'; tr.append(cell); body.append(tr);
      }
      for (const row of rows) {
        const tr = node('tr'); tr.dataset.qeRow = String(row.id);
        tr.classList.toggle('qe-selected', selectedId === row.id);
        if (onSelect) {
          tr.tabIndex = 0; tr.setAttribute('aria-selected', String(selectedId === row.id));
          tr.setAttribute('aria-label', `${row[cols[0].key] ?? row.id} 선택`);
          tr.onclick = () => select(row);
          tr.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row); }
          };
        }
        cols.forEach((column, index) => tr.append(makeCell(row, column, index === 0)));
        body.append(tr);
      }
    }
    frame.hidden = !currentRows.length; empty.hidden = !!currentRows.length;
    emptyText.textContent = spec.rows.length ? '검색 조건에 맞는 행이 없습니다.' : '표시할 관측이 없습니다.';
    clear.hidden = !query && !numericFilter; resetFilters.hidden=!query&&!numericFilter; download.disabled = !currentRows.length;
    edges();
  }
  function update(next) {
    if (destroyed) throw new Error('Table has been destroyed');
    if (!Array.isArray(next?.columns) || !next.columns.length || !Array.isArray(next.rows)) throw new TypeError('Table requires columns and rows');
    if (new Set(next.columns.map(c => c.key)).size !== next.columns.length) throw new TypeError('Column keys must be unique');
    if (next.rows.some(r => r.id == null) || new Set(next.rows.map(r => String(r.id))).size !== next.rows.length) throw new TypeError('Row ids must be present and unique');
    if(next.pageSize != null && (!Number.isInteger(next.pageSize)||next.pageSize<1||next.pageSize>500)) throw new TypeError('pageSize는 1~500 정수여야 합니다.');
    const rankKey=next.rankBy || next.columns.find(c=>numericTypes.has(c.type))?.key;
    const nextRankColumn=next.columns.find(c=>c.key===rankKey && numericTypes.has(c.type));
    if(next.rankBy!=null&&!nextRankColumn)throw new TypeError('rankBy는 숫자 열이어야 합니다.');
    if(next.rankDirection!=null&&!['asc','desc'].includes(next.rankDirection))throw new TypeError('rankDirection은 asc 또는 desc입니다.');
    const nextSize = next.pageSize ?? 20;
    if(nextSize!==pageSize)pageIndex=0;
    pageSize=nextSize;
    extents = new Map(next.columns.map(column=>[column.key,columnExtent(next.rows,column)]));
    if(numericFilter && !next.columns.some(c=>c.key===numericFilter.key&&numericTypes.has(c.type)))numericFilter=null;
    const numericColumns=next.columns.filter(c=>numericTypes.has(c.type));
    range.hidden=!numericColumns.length;
    rangeColumn.replaceChildren(...numericColumns.map(c=>{const option=node('option','',c.label+(c.unit?` (${c.unit})`:c.type==='percent'?' (%)':''));option.value=c.key;return option;}));
    if(numericFilter)rangeColumn.value=numericFilter.key;
    const priorKeys = spec ? new Set(spec.columns.map(c => c.key)) : new Set();
    visibleKeys = new Set(next.columns.filter(c => !priorKeys.has(c.key) || visibleKeys.has(c.key)).map(c => c.key));
    visibleKeys.add(next.columns[0].key);
    const initialRanked=!spec && next.variant==='ranked';
    spec = next;rankColumn=nextRankColumn;ranks=new Map();
    if(rankColumn){let previousValue,previousRank;sortRows(next.rows,rankColumn,next.rankDirection||'desc').forEach((row,index)=>{const value=numberValue(row[rankColumn.key]);if(value==null)return;const rank=value===previousValue?previousRank:index+1;ranks.set(row.id,rank);previousValue=value;previousRank=rank;});}
    if(initialRanked&&rankColumn)sort={key:rankColumn.key,direction:next.rankDirection||'desc'};
    if (sort && !next.columns.some(c => c.key === sort.key)) sort = null;
    if (selectedId != null && !next.rows.some(row => row.id === selectedId)) selectedId = null;
    columnChoices.replaceChildren();
    next.columns.forEach((column, index) => {
      const label = node('label'); const input = node('input'); input.type = 'checkbox';
      input.checked = visibleKeys.has(column.key); input.disabled = index === 0;
      input.onchange = () => { input.checked ? visibleKeys.add(column.key) : visibleKeys.delete(column.key); render(); };
      label.append(input, doc.createTextNode(column.label + (index === 0 ? ' · 고정' : ''))); columnChoices.append(label);
    });
    render();
  }
  search.oninput = () => { query = search.value; pageIndex=0; render(); };
  function resetRange(){ numericFilter=null;rangeMin.value='';rangeMax.value='';rangeError.textContent='';rangeMin.removeAttribute('aria-invalid');rangeMax.removeAttribute('aria-invalid');pageIndex=0;render(); }
  resetFilters.onclick = () => clear.click();
  clear.onclick = () => { query = ''; search.value = '';resetRange();search.focus(); };
  rangeClear.onclick = resetRange;
  for(const details of [chooser,range])details.addEventListener('toggle',()=>{if(details.open)(details===chooser?range:chooser).open=false;});
  for(const details of [chooser,range])details.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();details.open=false;details.querySelector('summary').focus();}});
  rangeApply.onclick = () => {
    try {
      if(rangeMin.validity.badInput || rangeMax.validity.badInput)throw new TypeError('유효한 숫자를 입력하세요.');
      const min = rangeMin.value.trim()===''?null:Number(rangeMin.value), max = rangeMax.value.trim()===''?null:Number(rangeMax.value);
      filterNumericRows([],rangeColumn.value,min,max);
      numericFilter=min==null&&max==null?null:{key:rangeColumn.value,min,max};
      rangeError.textContent='';rangeMin.removeAttribute('aria-invalid');rangeMax.removeAttribute('aria-invalid');pageIndex=0;render();
    }catch(error){ rangeError.textContent=error.message+' 마지막 적용 조건을 유지합니다.';rangeMin.setAttribute('aria-invalid','true');rangeMax.setAttribute('aria-invalid','true'); }
  };
  rangeControls.onkeydown = event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'){event.preventDefault();rangeApply.click();}};
  previous.onclick = ()=>{pageIndex=Math.max(0,pageIndex-1);render();};
  next.onclick = ()=>{pageIndex++;render();};
  density.onclick = () => { compact = !compact; render(); };
  scroll.addEventListener('scroll', edges, { passive: true });
  win.addEventListener('resize', edges);
  download.onclick = () => {
    const url = win.URL.createObjectURL(new Blob(['\uFEFF' + toCSV(currentRows, columns())], { type: 'text/csv;charset=utf-8' }));
    const link = node('a'); link.href = url;
    link.download = `${String(spec.id || 'table').replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`; link.click();
    const timer = win.setTimeout(() => { win.URL.revokeObjectURL(url); urlTimers.delete(record); }, 1000);
    const record = { timer, url }; urlTimers.add(record);
  };
  try { update(initialSpec); } catch (error) { root.remove(); win.removeEventListener('resize', edges); throw error; }
  if (win.ResizeObserver) { observer = new win.ResizeObserver(edges); observer.observe(scroll); }
  return {
    update,
    setTheme(value) { if (!destroyed) { theme = String(value); root.dataset.theme = theme; } },
    getState() { return { query, compact, sort: sort ? { ...sort } : null, selectedId, theme, visibleColumns: columns().map(c => c.key), filteredRowIds: currentRows.map(r => r.id), pageRowIds:pageRows.map(r=>r.id), pageIndex, pageSize, numericFilter:numericFilter?{...numericFilter}:null }; },
    destroy() {
      if (destroyed) return; destroyed = true;
      observer?.disconnect(); win.removeEventListener('resize', edges); scroll.removeEventListener('scroll', edges);
      for (const { timer, url } of urlTimers) { win.clearTimeout(timer); win.URL.revokeObjectURL(url); }
      urlTimers.clear(); root.remove();
    }
  };
}
