import {contrastRatio,mixColor} from './tokens.js';
/** Quant chart renderer. Pure specs in, ECharts options out; no data fetching or aggregation. */
export const CHART_KINDS = Object.freeze(['line', 'area', 'bar', 'diverging', 'slope', 'dumbbell', 'scatter', 'heatmap', 'boxplot', 'histogram', 'waterfall', 'range', 'small-multiples', 'calendar', 'fan', 'bullet', 'treemap']);

const DEFAULT_TOKENS = Object.freeze({ bg:'#101416', surface:'#171d20', raised:'#20282c', text:'#edf3f2', muted:'#a6b4b6', border:'#364247', accent:'#69d3cf', positive:'#78c6a3', negative:'#ee9298', palette:['#69d3cf','#dcb878','#9ca9ee','#dd9bc3','#92bb83','#76afd9'] });
const numberFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits:2 });
export function formatChartNumber(value) {
  if (value == null || !Number.isFinite(value)) return '미제공';
  if (value !== 0 && Math.abs(value) < .01) return new Intl.NumberFormat('ko-KR', {maximumSignificantDigits:2}).format(value);
  return numberFormat.format(value);
}
const fail = message => { throw new TypeError(`Chart spec: ${message}`); };
const list = (value, name) => { if (!Array.isArray(value) || !value.length) fail(`${name} must be a non-empty array`); return value; };
const numeric = (value, name, nullable=false) => { if (nullable && value === null) return value; if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be a finite number${nullable?' or null':''}`); return value; };
const label = (value, name) => { if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`); return value; };
const unique = (values, name) => { if (new Set(values).size !== values.length) fail(`${name} must be unique`); };
function date(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${name} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== value) fail(`${name} is not a valid calendar date`);
  return value;
}
function tokensWithDefaults(tokens={}) { return { ...DEFAULT_TOKENS, ...tokens, palette:tokens.palette?.length?tokens.palette:DEFAULT_TOKENS.palette }; }
function domain(values, includeZero=false) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return [0,1];
  let low=Math.min(...nums), high=Math.max(...nums);
  if (includeZero) { low=Math.min(0,low); high=Math.max(0,high); }
  const pad=(high-low || Math.abs(high) || 1)*.08;
  return [low-pad,high+pad];
}

function validate(spec) {
  if (!spec || !CHART_KINDS.includes(spec.kind)) fail(`unknown kind ${spec?.kind}`);
  if (['line','area','small-multiples'].includes(spec.kind)) {
    list(spec.x,'x').forEach((x,i)=>label(x,`x[${i}]`)); unique(spec.x,'x');
    list(spec.series,'series').forEach((s,i)=>{
      label(s.name,`series[${i}].name`);
      if (!Array.isArray(s.data)||s.data.length!==spec.x.length) fail(`series[${i}].data length must match x`);
      s.data.forEach((v,j)=>numeric(v,`series[${i}].data[${j}]`,true));
    });
    unique(spec.series.map(s=>s.name),'series names');
  } else if (spec.kind==='fan') {
    list(spec.x,'x').forEach((x,i)=>{date(x,`x[${i}]`);if(i&&x<=spec.x[i-1])fail('fan dates must be strictly increasing');});
    if(!Number.isInteger(spec.forecastStart)||spec.forecastStart<1||spec.forecastStart>=spec.x.length)fail('forecastStart must identify an existing date after at least one observed date');
    if(!['prediction','confidence','scenario'].includes(spec.intervalKind))fail('fan intervalKind must be prediction, confidence or scenario');
    label(spec.method,'method');
    const vector=(values,name)=>{if(!Array.isArray(values)||values.length!==spec.x.length)fail(`${name} length must match x`);values.forEach((v,i)=>numeric(v,`${name}[${i}]`,true));};
    vector(spec.observed,'observed');vector(spec.center,'center');
    if(spec.observed.every(v=>v===null)||spec.center.every(v=>v===null))fail('fan requires observed and central estimate evidence');
    spec.observed.forEach((v,i)=>{if(i>spec.forecastStart&&v!==null)fail('observed values must not cross the forecast boundary');});
    spec.center.forEach((v,i)=>{if(i<spec.forecastStart&&v!==null)fail('central estimates must not precede forecastStart');});
    list(spec.intervals,'intervals').forEach((band,b)=>{
      numeric(band.level,`intervals[${b}].level`);if(band.level<=0||band.level>=1)fail('interval level must be between zero and one');
      vector(band.low,`intervals[${b}].low`);vector(band.high,`intervals[${b}].high`);
      band.low.forEach((low,i)=>{const high=band.high[i],center=spec.center[i];
        if((low===null)!==(high===null))fail('interval endpoints must be missing together');
        if(i<spec.forecastStart&&low!==null)fail('intervals must not precede forecastStart');
        if(low!==null&&(low>high||center===null||center<low||center>high))fail('fan requires low <= center <= high at each available interval');
      });
      if(band.low.every(v=>v===null))fail('fan interval must contain evidence');
    });
    unique(spec.intervals.map(b=>b.level),'interval levels');
    const ordered=[...spec.intervals].sort((a,b)=>a.level-b.level);
    ordered.slice(1).forEach((outer,j)=>outer.low.forEach((low,i)=>{
      const inner=ordered[j];if((low===null)!==(inner.low[i]===null))fail('nested intervals must share their missingness pattern');
      if(low!==null&&(low>inner.low[i]||outer.high[i]<inner.high[i]))fail('higher-level interval must contain every lower-level interval');
    }));
  } else if (spec.kind==='bullet') {
    list(spec.rows,'rows').forEach((r,i)=>{
      label(r.name,`rows[${i}].name`);numeric(r.value,`rows[${i}].value`);numeric(r.target,`rows[${i}].target`);
      if(!Array.isArray(r.ranges)||r.ranges.length!==3)fail('bullet ranges require three increasing thresholds');
      r.ranges.forEach((v,j)=>{numeric(v,`rows[${i}].ranges[${j}]`);if(v<=0||(j&&v<=r.ranges[j-1]))fail('bullet ranges must be positive and strictly increasing');});
      if(r.value<0||r.target<0||r.value>r.ranges[2]||r.target>r.ranges[2])fail('bullet value and target must lie within the declared nonnegative range');
    });unique(spec.rows.map(r=>r.name),'row names');
  } else if (spec.kind==='treemap') {
    const active=new Set();
    const total=(nodes,depth=0)=>{
      if(depth>32)fail('treemap nesting exceeds 32 levels');
      list(nodes,'nodes');unique(nodes.map(n=>n?.name),'sibling names');
      return nodes.reduce((sum,n)=>{
        if(!n||typeof n!=='object'||active.has(n))fail('treemap requires acyclic nodes');
        label(n.name,'node.name');active.add(n);let value;
        if(n.children!==undefined){value=total(n.children,depth+1);if(n.value!==undefined){numeric(n.value,'node.value');if(Math.abs(n.value-value)>Math.max(1,value)*1e-10)fail('parent value must equal the sum of its children');}}
        else value=numeric(n.value,'leaf.value');
        active.delete(n);if(value<0)fail('treemap values must be nonnegative');
        if(!Number.isFinite(sum+value))fail('treemap total must be finite');return sum+value;
      },0);
    };
    if(total(spec.nodes)<=0)fail('treemap requires a positive total');
  } else if (spec.kind==='scatter') {
    list(spec.points,'points').forEach((p,i)=>{label(p.name,`points[${i}].name`);numeric(p.x,`points[${i}].x`);numeric(p.y,`points[${i}].y`);});
  } else if (spec.kind==='heatmap') {
    list(spec.x,'x').forEach((v,i)=>label(v,`x[${i}]`)); list(spec.y,'y').forEach((v,i)=>label(v,`y[${i}]`)); unique(spec.x,'x');unique(spec.y,'y');
    list(spec.values,'values').forEach((v,i)=>{
      if(!Array.isArray(v)||v.length!==3||!Number.isInteger(v[0])||!Number.isInteger(v[1])||v[0]<0||v[0]>=spec.x.length||v[1]<0||v[1]>=spec.y.length) fail(`values[${i}] has invalid heatmap coordinates`);
      numeric(v[2],`values[${i}][2]`,true);
    });
    unique(spec.values.map(v=>`${v[0]},${v[1]}`),'heatmap coordinates');
  } else if (spec.kind==='histogram') {
    list(spec.bins,'bins').forEach((b,i)=>{numeric(b.start,`bins[${i}].start`);numeric(b.end,`bins[${i}].end`);numeric(b.count,`bins[${i}].count`);if(b.start>=b.end||b.count<0||!Number.isInteger(b.count)) fail(`bins[${i}] needs start < end and a nonnegative integer count`);if(i&&b.start<spec.bins[i-1].end)fail('histogram bins must be ordered and non-overlapping');});
    const width=spec.bins[0].end-spec.bins[0].start;
    if(spec.bins.some(b=>Math.abs((b.end-b.start)-width)>Math.max(1,Math.abs(width))*1e-10))fail('count histogram requires equal-width bins; supply density as a separately defined metric for unequal bins');
  } else if (spec.kind==='calendar') {
    list(spec.values,'values').forEach((v,i)=>{if(!Array.isArray(v)||v.length!==2)fail(`values[${i}] must be [date,value]`);date(v[0],`values[${i}][0]`);numeric(v[1],`values[${i}][1]`,true);});
    unique(spec.values.map(v=>v[0]),'calendar dates');
    if (spec.range != null) {
      if(Array.isArray(spec.range)) { if(spec.range.length!==2)fail('calendar range requires two dates');spec.range.forEach((v,i)=>date(v,`range[${i}]`));if(spec.range[0]>spec.range[1])fail('calendar range start must precede end'); }
      else if(typeof spec.range!=='string'||!/^\d{4}$/.test(spec.range)) fail('calendar range must be YYYY or [start,end]');
      const lo=Array.isArray(spec.range)?spec.range[0]:`${spec.range}-01-01`,hi=Array.isArray(spec.range)?spec.range[1]:`${spec.range}-12-31`;
      if(spec.values.some(v=>v[0]<lo||v[0]>hi))fail('calendar data lies outside range');
    }
  } else {
    list(spec.rows,'rows').forEach((r,i)=>{
      label(r.name,`rows[${i}].name`);
      if(['slope','dumbbell'].includes(spec.kind)){numeric(r.start,`rows[${i}].start`);numeric(r.end,`rows[${i}].end`);}
      else if(spec.kind==='range'){numeric(r.low,`rows[${i}].low`);numeric(r.high,`rows[${i}].high`);if(r.low>r.high)fail(`rows[${i}] low must not exceed high`);if(r.value!==undefined){numeric(r.value,`rows[${i}].value`,true);if(r.value!==null&&(r.value<r.low||r.value>r.high))fail(`rows[${i}].value lies outside interval`);}}
      else if(spec.kind==='boxplot'){if(!Array.isArray(r.values)||r.values.length!==5)fail(`rows[${i}].values requires min,q1,median,q3,max`);r.values.forEach((v,j)=>{numeric(v,`rows[${i}].values[${j}]`);if(j&&v<r.values[j-1])fail(`rows[${i}] boxplot values must be ordered`);});}
      else numeric(r.value,`rows[${i}].value`,spec.kind!=='waterfall');
      if(spec.kind==='waterfall'&&r.type!=null&&!['delta','total'].includes(r.type))fail(`rows[${i}].type must be delta or total`);
    });
    unique(spec.rows.map(r=>r.name),'row names');
    if(spec.kind==='waterfall'&&spec.initial!==undefined)numeric(spec.initial,'initial');
  }
}

/** All arrays are read-only inputs. Null samples remain gaps, never zero or interpolated. */
export function buildOption(spec,tokens={}) {
  validate(spec);
  const t=tokensWithDefaults(tokens),unit=spec.unit||'';
  const labelOn=color=>contrastRatio(t.text,color)>=4.5?t.text:contrastRatio('#ffffff',color)>contrastRatio('#101416',color)?'#ffffff':'#101416';
  const fmt=v=>`${formatChartNumber(v)}${v==null?'':unit}`;
  const cat=(data,extra={})=>({type:'category',data:[...data],axisLine:{lineStyle:{color:t.border}},axisTick:{show:false},axisLabel:{color:t.muted,hideOverlap:true},...extra});
  const val=(extra={})=>({type:'value',name:spec.yLabel||unit,nameTextStyle:{color:t.muted},axisLabel:{color:t.muted,formatter:formatChartNumber},splitLine:{lineStyle:{color:t.border,type:'dashed'}},axisLine:{show:false},...extra});
  const o={backgroundColor:'transparent',color:[...t.palette],animation:false,textStyle:{fontFamily:'inherit',color:t.text},aria:{enabled:true,label:{enabled:true,description:spec.description||`${spec.title||spec.kind}. ${unit?`단위 ${unit}. `:''}정확한 값은 함께 제공된 데이터 표에서 확인할 수 있습니다.`}},grid:{left:16,right:24,top:40,bottom:24,containLabel:true},tooltip:{trigger:'item',renderMode:'richText',confine:true,backgroundColor:t.raised,borderColor:t.border,textStyle:{color:t.text},valueFormatter:fmt},series:[]};
  const legend={type:'scroll',top:0,textStyle:{color:t.muted},pageTextStyle:{color:t.muted},pageIconColor:t.text,pageIconInactiveColor:t.border};
  switch(spec.kind) {
    case 'line': case 'area': {
      o.legend={...legend,selected:Object.fromEntries(spec.series.map(s=>[s.name,s.visible!==false]))};
      o.grid.top=60;
      o.xAxis=cat(spec.x,{boundaryGap:false,name:spec.xLabel||''});o.yAxis=val({scale:spec.kind!=='area'});
      if(spec.kind==='area'){
        // Filled area encodes distance from zero; never use a truncated baseline.
        const observed=spec.series.flatMap(s=>s.data).filter(v=>v!==null);
        const low=Math.min(0,...observed),high=Math.max(0,...observed);
        o.yAxis.min=low;o.yAxis.max=high===low?1:high;
      }
      o.grid.bottom=24;
      if(spec.zoom!==false)o.dataZoom=[{type:'inside',xAxisIndex:0,filterMode:'none',zoomOnMouseWheel:true,moveOnMouseMove:true,moveOnMouseWheel:false,preventDefaultMouseMove:false}];
      if(spec.brush){
        o.brush={xAxisIndex:0,brushType:'lineX',brushMode:'single',transformable:true,brushStyle:{color:t.accent+'22',borderColor:t.accent},toolbox:[]};
        // Brush may synthesize toolbox features internally; host controls own them.
        o.toolbox={show:false};
      }
      o.series=spec.series.map((s,i)=>({id:s.id||s.name,name:s.name,type:'line',data:[...s.data],connectNulls:false,showSymbol:false,symbolSize:7,smooth:false,lineStyle:{width:2.4,type:s.dashed?'dashed':'solid',color:s.color||t.palette[i%t.palette.length]},itemStyle:{color:s.color||t.palette[i%t.palette.length]},emphasis:{focus:'series'},...(spec.kind==='area'?{areaStyle:{opacity:.12}}:{})}));
      o.tooltip.trigger='axis';o.tooltip.axisPointer={type:'line',lineStyle:{color:t.muted,type:'dashed'}};
      break;
    }
    case 'fan': {
      const labels={prediction:'예측구간',confidence:'신뢰구간',scenario:'시나리오 범위 수준'};
      const intervalLabel=band=>`${formatChartNumber(band.level*100)}% ${labels[spec.intervalKind]}`;
      o.grid.top=64;o.legend={...legend,selectedMode:false};
      o.xAxis=cat(spec.x,{boundaryGap:false});o.yAxis=val({scale:true});
      const sorted=[...spec.intervals].sort((a,b)=>b.level-a.level);
      o.series=sorted.map((band,bandIndex)=>({
        type:'custom',name:intervalLabel(band),silent:true,z:1+bandIndex,
        // Explicit quadrilaterals avoid signed-stack errors for intervals crossing zero.
        data:band.low.flatMap((low,i)=>i<spec.x.length-1&&low!==null&&band.low[i+1]!==null?[[i,low,band.high[i],i+1,band.low[i+1],band.high[i+1]]]:[]),
        encode:{x:[0,3],y:[1,2,4,5]},itemStyle:{color:t.accent,opacity:.15},
        renderItem(params,api){return {type:'polygon',shape:{points:[api.coord([api.value(0),api.value(1)]),api.coord([api.value(0),api.value(2)]),api.coord([api.value(3),api.value(5)]),api.coord([api.value(3),api.value(4)])]},style:{fill:t.accent,opacity:.15}};}
      }));
      o.series.push({name:'관측',type:'line',data:[...spec.observed],connectNulls:false,showSymbol:false,z:10,itemStyle:{color:t.text},lineStyle:{color:t.text,width:2.5}},
        {name:'중앙 추정',type:'line',data:[...spec.center],connectNulls:false,showSymbol:false,z:11,itemStyle:{color:t.accent},lineStyle:{color:t.accent,type:'dashed',width:2.5},markLine:{silent:true,symbol:'none',label:{formatter:'예측 시작',color:t.muted,position:'insideEndTop'},lineStyle:{color:t.muted,type:'dotted'},data:[{xAxis:spec.x[spec.forecastStart]}]}});
      o.legend.data=[...sorted.map(intervalLabel),'관측','중앙 추정'];
      o.tooltip.trigger='axis';o.tooltip.axisPointer={type:'line',lineStyle:{color:t.muted,type:'dashed'}};
      o.tooltip.formatter=params=>{const first=Array.isArray(params)?params[0]:params;const i=spec.x.indexOf(first?.axisValue);if(i<0)return '';return [spec.x[i],`관측 ${fmt(spec.observed[i])}`,`중앙 추정 ${fmt(spec.center[i])}`,...sorted.map(b=>`${intervalLabel(b)} ${fmt(b.low[i])} – ${fmt(b.high[i])}`),`방법: ${spec.method}`].join('\n');};
      o.aria.label.description=`${spec.title||'팬 차트'}. ${labels[spec.intervalKind]}; ${sorted.map(b=>formatChartNumber(b.level*100)+'%').join(', ')}. 방법 ${spec.method}. 예측 시작 ${spec.x[spec.forecastStart]}. 구간은 사전 계산값이며 화면에서 추정하지 않습니다.`;
      break;
    }
    case 'bullet': {
      o.xAxis=val({name:spec.xLabel||unit,min:0,max:Math.max(...spec.rows.map(r=>r.ranges[2]))});o.yAxis=cat(spec.rows.map(r=>r.name),{inverse:true});
      o.series=[{type:'custom',name:'실제 · 목표',data:spec.rows.map((r,i)=>[i,r.value,r.target,...r.ranges]),encode:{x:[1,2,3,4,5],y:0},renderItem(params,api){
        const y=api.coord([0,api.value(0)])[1],rowHeight=Math.abs(api.size([0,1])[1]),height=Math.min(30,rowHeight*.55),children=[];
        let prior=0;for(let band=0;band<3;band++){const a=api.coord([prior,api.value(0)])[0],b=api.coord([api.value(band+3),api.value(0)])[0];children.push({type:'rect',shape:{x:a,y:y-height/2,width:Math.max(0,b-a),height},style:{fill:t.muted,opacity:.1+band*.08}});prior=api.value(band+3);}
        const zero=api.coord([0,api.value(0)])[0],value=api.coord([api.value(1),api.value(0)])[0],target=api.coord([api.value(2),api.value(0)])[0];
        children.push({type:'rect',shape:{x:zero,y:y-height*.16,width:Math.max(0,value-zero),height:height*.32},style:{fill:t.accent}}, {type:'line',shape:{x1:target,y1:y-height*.42,x2:target,y2:y+height*.42},style:{stroke:t.text,lineWidth:2.5}});
        return {type:'group',children};
      }}];
      o.tooltip.formatter=p=>{const r=spec.rows[p.dataIndex];return `${r.name}\n실제 ${fmt(r.value)}\n목표 ${fmt(r.target)}\n기준 구간 ${r.ranges.map(fmt).join(' / ')}`;};
      o.aria.label.description=`${spec.title||'목표 대비 실적'}. 가는 청록 막대는 실제값, 세로 표식은 목표값, 배경은 사전 선언한 세 기준 구간입니다. 모든 행은 같은 축을 사용합니다.`;
      break;
    }
    case 'treemap': {
      delete o.grid;
      const copy=nodes=>nodes.map(n=>{const children=n.children?copy(n.children):undefined;return {name:n.name,value:children?children.reduce((sum,c)=>sum+c.value,0):n.value,...(children?{children}:{})};});
      const nodes=copy(spec.nodes),total=nodes.reduce((sum,n)=>sum+n.value,0);
      const tint=(n,color,depth=0)=>{const fill=mixColor(t.surface,color,.16+Math.min(depth,3)*.04),border=mixColor(t.surface,color,.28);n.itemStyle={color:fill,borderColor:border};n.label={color:labelOn(fill)};n.upperLabel={color:labelOn(border)};n.children?.forEach(child=>tint(child,color,depth+1));};nodes.forEach((n,i)=>tint(n,t.palette[i%t.palette.length]));
      o.series=[{type:'treemap',name:spec.title||'구성',data:nodes,top:8,left:8,right:8,bottom:8,roam:false,nodeClick:false,breadcrumb:{show:false},leafDepth:undefined,visibleMin:0,squareRatio:1.3,label:{show:true,color:t.text,formatter:p=>`${p.name}\n${fmt(p.value)}`,overflow:'truncate'},upperLabel:{show:true,height:26,color:t.text},itemStyle:{borderColor:t.surface,borderWidth:2,gapWidth:3},levels:[{itemStyle:{gapWidth:5,borderWidth:0},upperLabel:{show:false}},{itemStyle:{borderWidth:2,gapWidth:2},upperLabel:{show:true}},{itemStyle:{borderWidth:1,gapWidth:1}}]}];
      o.tooltip.formatter=p=>`${(p.treePathInfo||[]).map(n=>n.name).filter(Boolean).join(' / ')||p.name}\n${fmt(p.value)} · 전체의 ${formatChartNumber(p.value/total*100)}%`;
      o.aria.label.description=`${spec.title||'계층별 구성'}. 면적은 비음수 값에 비례합니다. 전체 ${fmt(total)}. 작은 영역의 정확값도 데이터 표로 확인할 수 있습니다.`;
      break;
    }
    case 'bar': case 'diverging': {
      o.xAxis=val({name:spec.xLabel||unit});o.yAxis=cat(spec.rows.map(r=>r.name),{inverse:true});
      const max=Math.max(...spec.rows.map(r=>Math.abs(r.value??0)),1);
      if(spec.kind==='diverging'){o.xAxis.min=-max;o.xAxis.max=max;}
      o.series=[{name:spec.title||'값',type:'bar',barMaxWidth:24,data:spec.rows.map(r=>({name:r.name,value:r.value,itemStyle:{color:r.value<0?t.negative:t.accent}})),label:{show:false},...(spec.kind==='diverging'?{markLine:{silent:true,symbol:'none',data:[{xAxis:0}],lineStyle:{color:t.muted,type:'solid'},label:{show:false}}}:{})}];
      break;
    }
    case 'slope': {
      o.legend=legend;o.xAxis=cat([spec.startLabel||'시작',spec.endLabel||'종료'],{boundaryGap:['16%','16%']});o.yAxis=val({scale:true});
      o.series=spec.rows.map((r,i)=>({name:r.name,type:'line',data:[r.start,r.end],symbolSize:8,lineStyle:{width:2},endLabel:{show:true,formatter:()=>r.name,color:t.palette[i%t.palette.length]},labelLayout:{moveOverlap:'shiftY'}}));o.grid.right=100;
      break;
    }
    case 'dumbbell': case 'range': {
      o.xAxis=val({name:spec.xLabel||unit,scale:true});o.yAxis=cat(spec.rows.map(r=>r.name),{inverse:true});
      const range=spec.kind==='range';
      const data=spec.rows.map((r,i)=>[i,range?r.low:r.start,range?r.high:r.end,range?(r.value??null):null]);
      o.series=[{type:'custom',name:spec.title||'구간',data,encode:{x:[1,2],y:0},renderItem(params,api){
        const a=api.coord([api.value(1),api.value(0)]),b=api.coord([api.value(2),api.value(0)]),color=t.palette[params.dataIndex%t.palette.length];
        const children=[{type:'line',shape:{x1:a[0],y1:a[1],x2:b[0],y2:b[1]},style:{stroke:color,lineWidth:range?8:3,opacity:range?.55:1}},{type:'circle',shape:{cx:a[0],cy:a[1],r:range?3:5},style:{fill:range?color:t.surface,stroke:color,lineWidth:2}},{type:'circle',shape:{cx:b[0],cy:b[1],r:range?3:5},style:{fill:color}}];
        if(range&&spec.rows[params.dataIndex].value!=null){const p=api.coord([api.value(3),api.value(0)]);children.push({type:'circle',shape:{cx:p[0],cy:p[1],r:5},style:{fill:t.text,stroke:t.surface,lineWidth:2}});}
        return {type:'group',children};
      },tooltip:{formatter:p=>{const r=spec.rows[p.dataIndex];return range?`${r.name}\n구간 ${fmt(r.low)} – ${fmt(r.high)}${r.value!=null?`\n관측값 ${fmt(r.value)}`:''}`:`${r.name}\n${spec.startLabel||'시작'} ${fmt(r.start)}\n${spec.endLabel||'종료'} ${fmt(r.end)}`;}}}];
      break;
    }
    case 'scatter': {
      o.xAxis=val({name:spec.xLabel||'',scale:true});o.yAxis=val({scale:true});
      const groups=[...new Set(spec.points.map(p=>p.group||'관측값'))];if(groups.length>1)o.legend=legend;
      o.series=groups.map(g=>({name:g,type:'scatter',symbolSize:10,data:spec.points.filter(p=>(p.group||'관측값')===g).map(p=>({name:p.name,value:[p.x,p.y]}))}));
      o.tooltip.formatter=p=>`${p.name}\n${spec.xLabel||'X'} ${formatChartNumber(p.value[0])}\n${spec.yLabel||'Y'} ${fmt(p.value[1])}`;
      break;
    }
    case 'heatmap': {
      o.xAxis=cat(spec.x,{splitArea:{show:false},axisLabel:{color:t.muted,interval:0,hideOverlap:true}});o.yAxis=cat(spec.y,{inverse:true});
      const numbers=spec.values.map(v=>v[2]).filter(v=>v!==null), max=Math.max(...numbers.map(Math.abs),1e-12);
      const min=spec.symmetric===false?Math.min(...numbers,0):-max;
      o.visualMap={min,max:spec.symmetric===false?Math.max(...numbers,1e-12):max,calculable:false,orient:'horizontal',left:'center',bottom:0,inRange:{color:spec.symmetric===false?[t.surface,t.accent]:[t.negative,t.surface,t.accent]},textStyle:{color:t.muted},formatter:formatChartNumber};o.grid.bottom=70;
      o.series=[{type:'heatmap',data:spec.values.filter(v=>v[2]!==null).map(v=>{const color=spec.symmetric===false?mixColor(t.surface,t.accent,(v[2]-min)/(o.visualMap.max-min||1)):mixColor(t.surface,v[2]<0?t.negative:t.accent,Math.abs(v[2])/max);return {value:[...v],itemStyle:{color},label:{color:labelOn(color)}};}),label:{show:spec.x.length<=8,formatter:p=>formatChartNumber(p.value[2]),color:t.text},itemStyle:{borderColor:t.surface,borderWidth:2},emphasis:{itemStyle:{borderColor:t.text,borderWidth:2}}}];
      o.tooltip.formatter=p=>`${spec.y[p.value[1]]} · ${spec.x[p.value[0]]}\n${fmt(p.value[2])}`;
      break;
    }
    case 'boxplot': {
      o.xAxis=cat(spec.rows.map(r=>r.name));o.yAxis=val({scale:true});o.series=[{type:'boxplot',data:spec.rows.map(r=>[...r.values]),itemStyle:{color:t.accent+'44',borderColor:t.accent,borderWidth:2}}];
      o.tooltip.formatter=p=>`${spec.rows[p.dataIndex].name}\n${['최솟값','Q1','중앙값','Q3','최댓값'].map((name,i)=>`${name} ${fmt(spec.rows[p.dataIndex].values[i])}`).join('\n')}`;break;
    }
    case 'histogram': {
      o.xAxis=val({name:spec.xLabel||unit,min:spec.bins[0].start,max:spec.bins.at(-1).end});o.yAxis=val({name:spec.yLabel||'빈도',minInterval:1});
      o.series=[{type:'custom',name:'빈도',data:spec.bins.map(b=>[b.start,b.end,b.count]),encode:{x:[0,1],y:2},renderItem(params,api){const a=api.coord([api.value(0),0]),b=api.coord([api.value(1),api.value(2)]);return {type:'rect',shape:{x:a[0]+1,y:b[1],width:Math.max(0,b[0]-a[0]-2),height:Math.max(0,a[1]-b[1])},style:{fill:t.accent,opacity:.8}};}}];
      o.tooltip.formatter=p=>{const b=spec.bins[p.dataIndex];return `${fmt(b.start)} ≤ 값 ${p.dataIndex===spec.bins.length-1?'≤':'<'} ${fmt(b.end)}\n빈도 ${formatChartNumber(b.count)}`;};break;
    }
    case 'waterfall': {
      let current=spec.initial??0;
      const segments=spec.rows.map((r,i)=>{const start=r.type==='total'?0:current;const end=r.type==='total'?r.value:current+r.value;current=end;return [i,start,end,r.value];});
      o.xAxis=cat(spec.rows.map(r=>r.name));o.yAxis=val();
      o.series=[{type:'custom',name:spec.title||'변화',data:segments,encode:{x:0,y:[1,2]},renderItem(params,api){const a=api.coord([api.value(0),api.value(1)]),b=api.coord([api.value(0),api.value(2)]),width=Math.max(2,Math.min(44,api.size([1,0])[0]*.6));return {type:'rect',shape:{x:a[0]-width/2,y:Math.min(a[1],b[1]),width,height:Math.max(1,Math.abs(a[1]-b[1]))},style:{fill:spec.rows[params.dataIndex].type==='total'?t.accent:api.value(3)<0?t.negative:t.positive}};}}];
      o.tooltip.formatter=p=>{const r=spec.rows[p.dataIndex],s=segments[p.dataIndex];return `${r.name}\n${r.type==='total'?'합계':'변화'} ${fmt(r.value)}\n${fmt(s[1])} → ${fmt(s[2])}`;};break;
    }
    case 'small-multiples': {
      const [min,max]=domain(spec.series.flatMap(s=>s.data));const count=spec.series.length;
      o.grid=spec.series.map((s,i)=>({left:45,right:20,top:`${i*100/count+7}%`,height:`${Math.max(7,100/count-11)}%`,containLabel:false}));
      o.title=spec.series.map((s,i)=>({text:s.name,left:45,top:`${i*100/count}%`,textStyle:{fontSize:12,fontWeight:500,color:t.text}}));
      o.xAxis=spec.series.map((s,i)=>cat(spec.x,{gridIndex:i,boundaryGap:false,axisLabel:{color:t.muted,show:i===count-1,hideOverlap:true}}));
      o.yAxis=spec.series.map((s,i)=>val({gridIndex:i,min,max,splitNumber:2,name:''}));
      o.series=spec.series.map((s,i)=>({name:s.name,type:'line',xAxisIndex:i,yAxisIndex:i,data:[...s.data],showSymbol:false,connectNulls:false,lineStyle:{width:2},itemStyle:{color:t.palette[i%t.palette.length]}}));o.tooltip.trigger='axis';o.axisPointer={link:[{xAxisIndex:'all'}]};break;
    }
    case 'calendar': {
      const ordered=spec.values.map(v=>v[0]).sort(),numbers=spec.values.map(v=>v[1]).filter(v=>v!==null),min=Math.min(...numbers,0),max=Math.max(...numbers,1);
      delete o.grid;
      o.calendar={range:spec.range||[ordered[0],ordered.at(-1)],top:30,left:40,right:20,cellSize:['auto',24],splitLine:{lineStyle:{color:t.border}},itemStyle:{color:t.surface,borderColor:t.bg,borderWidth:3},yearLabel:{show:false},dayLabel:{firstDay:1,nameMap:['일','월','화','수','목','금','토'],color:t.muted},monthLabel:{nameMap:'en',color:t.muted}};
      o.visualMap={min,max,calculable:false,orient:'horizontal',left:'center',bottom:0,inRange:{color:min<0?[t.negative,t.surface,t.accent]:[t.surface,t.accent]},textStyle:{color:t.muted},formatter:formatChartNumber};
      if(min<0){const abs=Math.max(Math.abs(min),Math.abs(max));o.visualMap.min=-abs;o.visualMap.max=abs;}
      o.series=[{type:'heatmap',coordinateSystem:'calendar',data:spec.values.filter(v=>v[1]!==null).map(v=>[...v])}];o.tooltip.formatter=p=>`${p.value[0]}\n${fmt(p.value[1])}`;break;
    }
  }
  return o;
}

/** Inject a full ECharts build. Returns a small controlled interface; no global engine required. */
export function mountChart(element,spec,{echarts,tokens={},onSelect=()=>{},onRange=()=>{},onStateChange=()=>{},onLegendChange=()=>{}}={}) {
  if(!element||typeof element.addEventListener!=='function')throw new TypeError('mountChart requires a DOM element');
  if(!echarts?.init)throw new TypeError('mountChart requires an injected ECharts instance');
  let currentSpec=spec,currentTokens=tokensWithDefaults(tokens),disposed=false,brushAnchor=null;
  buildOption(spec,currentTokens); // Reject malformed input before allocating a renderer.
  const chart=echarts.init(element,null,{renderer:'svg'});
  const state={selectedIndex:null,range:null,legend:{},zoom:{start:0,end:100},mode:'inspect'};
  const notify=()=>onStateChange({...state,zoom:{...state.zoom},legend:{...state.legend}});
  const priorTabIndex=element.getAttribute('tabindex'),priorRole=element.getAttribute('role'),priorLabel=element.getAttribute('aria-label');
  element.setAttribute('tabindex','0');element.setAttribute('role','group');
  const isLine=()=>['line','area','small-multiples'].includes(currentSpec.kind);
  const safeIndex=i=>Math.max(0,Math.min(currentSpec.x.length-1,Math.round(i)));
  function selectionPayload(i){return {index:i,x:currentSpec.x[i],series:currentSpec.series.filter(s=>state.legend[s.name]!==false).map(s=>({name:s.name,value:s.data[i]}))};}
  function select(index) {
    if(!isLine()||disposed)return;
    state.selectedIndex=index===null?null:safeIndex(index);
    if(index===null){chart.dispatchAction({type:'hideTip'});onSelect(null);notify();return;}
    const first=currentSpec.series.findIndex(s=>state.legend[s.name]!==false);
    if(first>=0)chart.dispatchAction({type:'showTip',seriesIndex:first,dataIndex:state.selectedIndex});
    onSelect(selectionPayload(state.selectedIndex));notify();
  }
  function setRange(start,end) {
    if(!isLine()||disposed)return;
    if(start==null||end==null){state.range=null;chart.dispatchAction({type:'brush',areas:[]});onRange(null);notify();return;}
    const a=safeIndex(Math.min(start,end)),b=safeIndex(Math.max(start,end));
    state.range={startIndex:a,endIndex:b,start:currentSpec.x[a],end:currentSpec.x[b]};
    if(currentSpec.brush)chart.dispatchAction({type:'brush',areas:[{brushType:'lineX',xAxisIndex:0,coordRange:[a,b]}]});
    onRange({...state.range});notify();
  }
  function render() {
    const o=buildOption(currentSpec,currentTokens);
    // The interactive host and adjacent data table supply accessible context.
    // ECharts' automatic description gives the host role=img on every redraw,
    // hiding its keyboard interaction semantics from assistive technologies.
    o.aria={...o.aria,enabled:false};
    if(o.legend){state.legend=Object.fromEntries((currentSpec.series?.map(s=>s.name)||o.series.map(s=>s.name)).map(name=>[name,state.legend[name]??o.legend.selected?.[name]??true]));o.legend.selected={...state.legend};}
    if(o.dataZoom)o.dataZoom=o.dataZoom.map(z=>({...z,...state.zoom,...(z.type==='inside'?{zoomOnMouseWheel:!['select','range'].includes(state.mode),moveOnMouseMove:!['select','range'].includes(state.mode)}:{})}));
    chart.setOption(o,{notMerge:true,lazyUpdate:false});
    // ECharts' automatic ARIA pass assigns role=img to its host. This host is
    // also our keyboard interaction group, so restore its interactive context.
    element.setAttribute('role','group');
    element.setAttribute('aria-label',`${currentSpec.title||currentSpec.kind}. ${isLine()?`좌우 방향키로 관측값 선택, +/-로 확대/축소, 0으로 전체 보기.${currentSpec.brush?' Shift와 방향키로 구간 선택.':''} Escape로 선택 해제. `:''}${o.aria?.label?.description||currentSpec.description||''}`);
    if(state.range&&currentSpec.brush)chart.dispatchAction({type:'brush',areas:[{brushType:'lineX',xAxisIndex:0,coordRange:[state.range.startIndex,state.range.endIndex]}]});
    if(currentSpec.brush)chart.dispatchAction({type:'takeGlobalCursor',key:'brush',brushOption:{brushType:['range','select'].includes(state.mode)?'lineX':false}});
    if(state.selectedIndex!==null)select(state.selectedIndex);
    notify();
  }
  function keydown(event) {
    if(!isLine()||event.target!==element)return;
    if(event.key==='Escape'){event.preventDefault();brushAnchor=null;select(null);setRange(null,null);if(state.mode==='select'||state.mode==='range'){state.mode='inspect';render();}return;}
    if(['+','=','-','0'].includes(event.key)&&currentSpec.zoom!==false){event.preventDefault();if(event.key==='0'){resetZoom();return;}const center=(state.zoom.start+state.zoom.end)/2,span=Math.min(100,Math.max(5,(state.zoom.end-state.zoom.start)*(event.key==='-'?1.3:.75)));const start=Math.max(0,Math.min(100-span,center-span/2));setZoom(start,start+span);return;}
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const prior=state.selectedIndex??0;
    const next=event.key==='Home'?0:event.key==='End'?currentSpec.x.length-1:prior+(event.key==='ArrowRight'?1:-1);
    if(event.shiftKey&&currentSpec.brush){brushAnchor??=prior;select(next);setRange(brushAnchor,state.selectedIndex);}else{brushAnchor=null;select(next);}
  }
  element.addEventListener('keydown',keydown);
  const zr=chart.getZr?.();
  function pointerClick(event){
    if(!['line','area'].includes(currentSpec.kind)||['range','select'].includes(state.mode))return;
    const point=[event.offsetX,event.offsetY];
    if(!chart.containPixel({gridIndex:0},point))return;
    const coordinate=chart.convertFromPixel({gridIndex:0},point);
    if(Number.isFinite(coordinate?.[0]))select(coordinate[0]);
  }
  zr?.on('click',pointerClick);
  chart.on('click',event=>{if(isLine()&&(currentSpec.kind==='small-multiples'||!zr)&&event.componentType==='series'&&Number.isInteger(event.dataIndex))select(event.dataIndex);});
  chart.on('legendselectchanged',event=>{state.legend={...event.selected};if(state.selectedIndex!==null)onSelect(selectionPayload(state.selectedIndex));notify();onLegendChange({...state.legend});});
  chart.on('datazoom',event=>{const z=event.batch?.[0]||event;if(Number.isFinite(z.start)&&Number.isFinite(z.end))state.zoom={start:z.start,end:z.end};else{const actual=chart.getOption().dataZoom?.[0];if(actual)state.zoom={start:actual.start,end:actual.end};}notify();});
  chart.on('brushEnd',event=>{const area=event.areas?.[0];if(!area){state.range=null;onRange(null);notify();}else if(Array.isArray(area.coordRange)){setRange(area.coordRange[0],area.coordRange[1]);}});
  function setZoom(start=0,end=100){if(disposed||currentSpec.zoom===false)return;if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>100||start>=end)throw new TypeError('Zoom must satisfy 0 ≤ start < end ≤ 100');state.zoom={start,end};chart.dispatchAction({type:'dataZoom',start,end});notify();}
  function resetZoom(){setZoom(0,100);}
  function doubleClick(){resetZoom();}
  element.addEventListener('dblclick',doubleClick);
  function resizeChart(){if(!disposed){chart.resize();element.setAttribute('role','group');}}
  let observer=null;
  function destroy(){
    if(disposed)return;
    disposed=true;observer?.disconnect();zr?.off('click',pointerClick);element.removeEventListener('keydown',keydown);element.removeEventListener('dblclick',doubleClick);
    for(const event of ['click','legendselectchanged','datazoom','brushEnd'])chart.off?.(event);
    for(const [key,value] of [['tabindex',priorTabIndex],['role',priorRole],['aria-label',priorLabel]]){if(value===null)element.removeAttribute(key);else element.setAttribute(key,value);}
    chart.dispose();
  }
  try{
    observer=typeof ResizeObserver==='function'?new ResizeObserver(resizeChart):null;
    observer?.observe(element);render();
  }catch(error){
    // A failed mount returns no handle, so ownership must be released here.
    try{destroy();}catch{/* Preserve the original rendering failure for callers. */}
    throw error;
  }
  return {
    update(nextSpec){if(disposed)return;buildOption(nextSpec,currentTokens);const changedX=JSON.stringify(currentSpec.x)!==JSON.stringify(nextSpec.x);currentSpec=nextSpec;if(changedX||!isLine()){state.selectedIndex=null;state.range=null;brushAnchor=null;state.zoom={start:0,end:100};}render();},
    setTheme(nextTokens){if(disposed)return;currentTokens=tokensWithDefaults(nextTokens);render();},
    select,setRange,
    setLegend(name,visible){if(disposed)return;if(!currentSpec.series?.some(s=>s.name===name)&&!chart.getOption().series?.some(s=>s.name===name))throw new TypeError(`Unknown series: ${name}`);state.legend[name]=Boolean(visible);chart.dispatchAction({type:visible?'legendSelect':'legendUnSelect',name});if(state.selectedIndex!==null)onSelect(selectionPayload(state.selectedIndex));},
    setMode(mode){if(disposed)return;if(!['inspect','range','select','zoom'].includes(mode))throw new TypeError('Chart mode must be inspect, select or zoom');state.mode=mode;render();},
    setZoom,resetZoom,
    resetView(){if(disposed)return;state.zoom={start:0,end:100};state.selectedIndex=null;state.range=null;state.mode='inspect';for(const name of Object.keys(state.legend))state.legend[name]=true;brushAnchor=null;render();onSelect(null);onRange(null);},
    getState(){return {selectedIndex:state.selectedIndex,cursor:state.selectedIndex,range:state.range?{...state.range}:null,legend:{...state.legend},hidden:Object.keys(state.legend).filter(name=>state.legend[name]===false),zoom:{...state.zoom},mode:state.mode};},
    resize:resizeChart,
    destroy
  };
}
