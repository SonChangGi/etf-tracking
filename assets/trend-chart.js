/* Responsive 0.4.1 trend renderer. Input observations and semantic colours are read-only. */
(function(scope){
'use strict';
scope.QuantETFTrend={mount(host,config){
  const {dates,series,colors,onObserve,onPin}=config;
  const chart=scope.echarts.init(host,null,{renderer:'svg'});
  let selected=dates.length-1, selectedKey=series[0].key, zoom=[0,100], brushing=false;
  const optionButton=document.createElement('details');optionButton.className='trend-options';
  optionButton.innerHTML='<summary aria-label="차트 옵션">···</summary><button type="button" data-brush>구간 분석</button>';
  const reset=document.createElement('button');reset.type='button';reset.className='trend-reset';reset.textContent='전체 보기';reset.hidden=true;
  const range=document.createElement('output');range.className='trend-range';range.hidden=true;
  const clear=document.createElement('button');clear.type='button';clear.textContent='구간 해제';clear.hidden=true;clear.className='trend-clear';
  host.before(optionButton,reset);host.after(range,clear);
  clear.onclick=()=>{range.hidden=true;clear.hidden=true;chart.dispatchAction({type:"brush",areas:[]});host.focus();};
  host.addEventListener("keydown",event=>{if(event.key==="Escape")clear.onclick();});
  const entries=new Map(series.map(s=>[s.key,new Map(s.points.map(p=>[p.date,p.value]))]));
  const fmt=v=>v==null?'미편입':`${Number(v).toLocaleString('ko-KR',{maximumFractionDigits:2})}%`;
  function render(){
    const style=getComputedStyle(document.documentElement), dark=document.documentElement.dataset.theme==='dark';
    const token=(name,fallback)=>style.getPropertyValue(name).trim()||fallback;
    const seriesColor=key=>{const color=colors.get(key);if(!dark||!/^#[0-9a-f]{6}$/i.test(color))return color;return '#'+[1,3,5].map(i=>Math.round(parseInt(color.slice(i,i+2),16)*.65+255*.35).toString(16).padStart(2,'0')).join('');};
    const text=token('--text',dark?'#edf3f2':'#172126'),muted=token('--muted',dark?'#a6b4b6':'#53646c'),border=token('--line',dark?'#364247':'#dce3e5');
    chart.setOption({animation:false,backgroundColor:'transparent',textStyle:{fontFamily:'Pretendard Variable, sans-serif',color:text},grid:{top:34,left:12,right:18,bottom:28,containLabel:true},tooltip:{trigger:'axis',confine:true,backgroundColor:dark?'#20282c':'#ffffff',borderColor:border,textStyle:{color:text,fontSize:12},valueFormatter:fmt,axisPointer:{type:'line'}},xAxis:{type:'category',data:dates,boundaryGap:false,axisLine:{lineStyle:{color:border}},axisTick:{show:false},axisLabel:{color:muted,hideOverlap:true,formatter:d=>d.slice(5),fontSize:12}},yAxis:{type:'value',min:0,name:'비중 (%)',nameTextStyle:{color:muted},axisLabel:{color:muted,fontSize:12,formatter:v=>`${v}%`},splitLine:{lineStyle:{color:border,type:'dashed'}}},dataZoom:[{type:'inside',start:zoom[0],end:zoom[1],filterMode:'none',preventDefaultMouseMove:false,zoomOnMouseWheel:false,moveOnMouseMove:true}],brush:{xAxisIndex:0,brushType:'lineX',brushMode:'single',toolbox:[],brushStyle:{color:'#69d3cf22',borderColor:'#69d3cf'}},toolbox:{show:false},series:series.flatMap(s=>[{id:s.key,name:s.fullLabel,type:'line',data:dates.map(d=>entries.get(s.key).get(d)??null),connectNulls:false,showSymbol:false,symbolSize:7,lineStyle:{width:s.key===selectedKey?2.8:1.8,color:seriesColor(s.key),type:s.isSparse?'dashed':'solid'},itemStyle:{color:seriesColor(s.key)},emphasis:{focus:'none'}},{id:s.key+'-events',name:s.fullLabel+' 신호',type:'scatter',data:s.signalPoints.filter(p=>Number.isFinite(p.value)).map(p=>({value:[p.date,p.value],name:p.actionLabel||p.kind,glyph:p.glyph||'',symbol:p.direction==='sell'?'triangle':'diamond',symbolRotate:p.direction==='sell'?180:0})),symbolSize:8,label:{show:true,formatter:p=>p.data.glyph,position:'top',fontSize:10,color:seriesColor(s.key)},itemStyle:{color:seriesColor(s.key)},tooltip:{formatter:p=>`${s.fullLabel}<br>${p.value[0]} · ${p.data.name}<br>${fmt(p.value[1])}`}}])},true);
  }
  chart.on('updateAxisPointer',event=>{const axis=event.axesInfo?.[0];if(!axis)return;const i=typeof axis.value==='number'?axis.value:dates.indexOf(axis.value);if(i>=0){selected=i;onObserve(dates[i]);}});
  chart.on('click',event=>{if(!event.seriesId)return;const s=series.find(s=>event.seriesId===s.key||event.seriesId===s.key+'-events');if(s){selectedKey=s.key;const date=Array.isArray(event.value)?event.value[0]:dates[event.dataIndex];onPin(date,s.key);}});
  chart.on('datazoom',()=>{const z=chart.getOption().dataZoom[0];zoom=[z.start,z.end];reset.hidden=zoom[0]<=0&&zoom[1]>=100;});
  reset.onclick=()=>{zoom=[0,100];chart.dispatchAction({type:'dataZoom',start:0,end:100});host.focus();};
  const zoomAt=(factor,ratio=.5)=>{const span=Math.max(100/Math.max(2,dates.length-1),Math.min(100,(zoom[1]-zoom[0])*factor)),anchor=zoom[0]+ratio*(zoom[1]-zoom[0]);let start=Math.max(0,Math.min(100-span,anchor-ratio*span));chart.dispatchAction({type:'dataZoom',start,end:start+span});};
  host.addEventListener('wheel',event=>{event.preventDefault();const rect=host.getBoundingClientRect();zoomAt(event.deltaY<0?.8:1.25,Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)));},{passive:false});
  host.addEventListener('keydown',event=>{if(!['+','=','-','0'].includes(event.key))return;event.preventDefault();if(event.key==='0')reset.onclick();else zoomAt(event.key==='-'?1.25:.8);});
  for(const [label,factor] of [['확대',.8],['축소',1.25]]){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{zoomAt(factor);optionButton.open=false;host.focus();};optionButton.append(button);}

  const brush=optionButton.querySelector('[data-brush]');
  brush.onclick=()=>{brushing=!brushing;chart.dispatchAction({type:'takeGlobalCursor',key:'brush',brushOption:{brushType:brushing?'lineX':false}});brush.textContent=brushing?'분석 종료':'구간 분석';optionButton.open=false;};
  chart.on('brushEnd',event=>{const area=event.areas?.[0];if(!area)return;const [a,b]=area.coordRange.map(v=>Math.max(0,Math.min(dates.length-1,Math.round(v)))).sort((a,b)=>a-b);range.hidden=false;clear.hidden=false;range.textContent=`${dates[a]} → ${dates[b]} · `+series.map(s=>{const v=entries.get(s.key),start=v.get(dates[a]),end=v.get(dates[b]);return `${s.label||s.fullLabel} ${Number.isFinite(start)&&Number.isFinite(end)?(end-start).toFixed(2)+'%p':'미제공'}`;}).join(' · ');});
  host.setAttribute('tabindex','0');host.setAttribute('role','img');
  const observer=new ResizeObserver(()=>chart.resize());observer.observe(host);
  const theme=new MutationObserver(()=>render());theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  render();
  return {select(date,key){selected=dates.indexOf(date);selectedKey=key;host.setAttribute('aria-label',date+' · '+series.map(s=>`${s.fullLabel} ${fmt(entries.get(s.key).get(date))}`).join(', '));chart.dispatchAction({type:'downplay'});const i=series.findIndex(s=>s.key===key);if(i>=0)chart.dispatchAction({type:'highlight',seriesIndex:i*2});},ensureVisible(date){const i=dates.indexOf(date),pct=i/Math.max(1,dates.length-1)*100;if(pct<zoom[0]||pct>zoom[1]){const span=zoom[1]-zoom[0];chart.dispatchAction({type:'dataZoom',start:Math.max(0,pct-span/2),end:Math.min(100,pct+span/2)});}},destroy(){observer.disconnect();theme.disconnect();chart.dispose();optionButton.remove();reset.remove();range.remove();clear.remove();}};
}};
})(window);
