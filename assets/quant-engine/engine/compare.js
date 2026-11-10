/** Pure common-date comparison. No interpolation or hidden reindexing per series. */
export function rebaseComparison(spec,start=0,end=spec.x?.length-1,base=100){
 if(!Array.isArray(spec.x)||!spec.x.length||!Array.isArray(spec.series)||!spec.series.length)throw new TypeError('공통 x와 series가 필요합니다.');
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>=spec.x.length||start>=end||!Number.isFinite(base)||base<=0)throw new TypeError('두 관측 이상인 유효 구간과 양수 기준값이 필요합니다.');
 const series=spec.series.map(s=>{if(!Array.isArray(s.data)||s.data.length!==spec.x.length)throw new TypeError('계열 길이가 일치해야 합니다.');const first=s.data[start];if(typeof first!=='number'||!Number.isFinite(first)||first<=0)throw new TypeError(`${s.name}: 공통 시작일의 양수 값이 필요합니다.`);return {...s,data:s.data.slice(start,end+1).map(v=>{if(v===null)return null;if(typeof v!=='number'||!Number.isFinite(v))throw new TypeError('유한한 숫자 또는 null이 필요합니다.');return v/first*base;})};});
 return {...spec,x:spec.x.slice(start,end+1),series,unit:`지수 · 시작 ${base}`};
}
