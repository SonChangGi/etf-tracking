/** Semantic KPI: a positive numerical change is not automatically good. */
export function validateMetric(spec) {
  if(spec.value!==null && (typeof spec.value!=='number'||!Number.isFinite(spec.value)))throw new TypeError('metric value는 유한한 숫자 또는 null이어야 합니다.');
  if(spec.precision!==undefined&&(!Number.isInteger(spec.precision)||spec.precision<0||spec.precision>6))throw new TypeError('precision은 0~6 정수입니다.');
  if(spec.history && (!Array.isArray(spec.history)||spec.history.some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)))))throw new TypeError('history는 숫자/null 배열입니다.');
  const c=spec.comparison;
  if(c){if(c.mode==='relative'&&c.value<0)throw new TypeError('음수 기준의 변화율 대신 절대 차이를 사용하세요.');if(typeof c.value!=='number'||!Number.isFinite(c.value)||typeof c.label!=='string'||!c.label.trim())throw new TypeError('비교값과 비교 기준 label이 필요합니다.');if(!['absolute','relative'].includes(c.mode)||!['higher','lower','neutral'].includes(c.desirable))throw new TypeError('comparison mode/desirable을 명시하세요.');}
}
export function metricChange(spec){
 validateMetric(spec);const c=spec.comparison;
 if(!c||spec.value===null)return null;
 if(c.mode==='relative'&&c.value===0)return {value:null,tone:'neutral',reason:'기준값 0 · 변화율 계산 불가'};
 const value=c.mode==='relative'?(spec.value-c.value)/Math.abs(c.value)*100:spec.value-c.value;
 const good=c.desirable==='higher'?value>0:c.desirable==='lower'?value<0:null;
 return {value,tone:value===0||good===null?'neutral':good?'positive':'negative',unit:c.mode==='relative'?'%':spec.unit==='%'?'%p':spec.unit||''};
}
export function mountMetric(element,initialSpec){
 const doc=element.ownerDocument;let spec=initialSpec,dead=false;
 const n=(tag,cls,text)=>{const e=doc.createElement(tag);e.className=cls||'';if(text!==undefined)e.textContent=text;return e;};
 const number=(v)=>v===null?'—':new Intl.NumberFormat('ko-KR',v!==0&&Math.abs(v)<10**-(spec.precision??1)?{maximumSignificantDigits:3}:{minimumFractionDigits:spec.precision??1,maximumFractionDigits:spec.precision??1}).format(v);
 function render(){
  validateMetric(spec);element.replaceChildren();element.className='qe-metric-body';
  const value=n('div','qe-metric-value',number(spec.value));value.append(n('span','qe-metric-unit',spec.unit||''));element.append(value);
  const change=metricChange(spec);if(change){const row=n('div','qe-metric-change');const badge=n('span','qe-delta qe-'+change.tone,change.value===null?change.reason:`${change.value>0?'↑ +':change.value<0?'↓ ':''}${number(change.value)}${change.unit}`);row.append(badge,n('span','qe-muted',spec.comparison.label));element.append(row);}
  if(spec.history?.length){const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 280 48');svg.setAttribute('role','img');svg.setAttribute('aria-label','추이: '+spec.history.map(v=>v??'미제공').join(', '));svg.classList.add('qe-metric-spark');const nums=spec.history.filter(v=>v!==null);if(nums.length){const min=Math.min(...nums),span=Math.max(...nums)-min||1;let d='',gap=true;spec.history.forEach((v,i)=>{if(v===null){gap=true;return;}d+=`${gap?'M':'L'}${4+i/Math.max(spec.history.length-1,1)*272},${44-(v-min)/span*38} `;gap=false;});const path=doc.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);}element.append(svg);}
 }
 render();return {update(next){if(dead)throw new Error('Metric destroyed');validateMetric(next);spec=next;render();},setTheme(){},getState:()=>({value:spec.value,change:metricChange(spec)}),destroy(){dead=true;element.replaceChildren();}};
}
