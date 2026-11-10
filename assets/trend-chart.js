/* Responsive 0.4.1 trend renderer. Input observations and semantic colours are read-only. */
(function(scope){
'use strict';
/* Direct range gesture: pointer drag, Alt-pan, two-touch pan/pinch; vertical touch stays native. */
function directDrag(host,api){
 let drag=null,suppress=false;const off=[];
 const on=(name,fn,opts)=>{host.addEventListener(name,fn,opts);off.push(()=>host.removeEventListener(name,fn,opts));};
 const point=e=>({x:e.clientX,y:e.clientY});
 on('pointerdown',e=>{if(e.button>0||e.pointerType==='touch')return;suppress=false;drag={...point(e),id:e.pointerId,pan:e.altKey,active:false,origin:api.point(e),view:api.view?.()};},{capture:true});
 on('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.active){if(Math.hypot(dx,dy)<6)return;drag.active=true;api.dragging?.(true);host.setPointerCapture?.(e.pointerId);}e.preventDefault();suppress=true;if(drag.pan)api.pan?.(dx,dy,drag.view);else api.select(drag.origin,api.point(e));},{capture:true});
 on('pointerup',()=>{drag=null;api.dragging?.(false);});on('pointercancel',()=>{drag=null;api.dragging?.(false);});
 on('click',e=>{if(suppress){suppress=false;e.preventDefault();e.stopImmediatePropagation();return;}api.clear();},{capture:true});
 on('keydown',e=>{if(e.key==='Escape')api.clear();});
 host.style.touchAction='pan-y';host.style.userSelect='none';host.style.webkitUserSelect='none';return()=>{off.forEach(fn=>fn());};
}

scope.QuantETFTrend={mount(host,config){
  const {dates,series,colors,onObserve,onPin}=config;
  const chart=scope.echarts.init(host,null,{renderer:'svg'});
  let selected=dates.length-1, selectedKey=series[0].key, zoom=[0,100],selectedRange=null;
  const reset=document.createElement('button');reset.type='button';reset.className='trend-reset';reset.textContent='전체 기간';reset.dataset.quantResetView='';reset.hidden=true;
  const range=document.createElement('output');range.className='trend-range';range.dataset.quantChartReadout='';range.setAttribute('aria-live','polite');range.hidden=true;
  const clear=document.createElement('button');clear.type='button';clear.textContent='구간 해제';clear.hidden=true;clear.className='trend-clear';
  host.after(range,clear,reset);
  const presentation=scope.QuantRangeReadout;
  const presenter=presentation?.createRangeReadout(host,range);
  const geometry=()=>{
    if(!selectedRange)return;
    const avoid=series.flatMap(item=>selectedRange.flatMap(i=>{
      const value=entries.get(item.key).get(dates[i]);
      return Number.isFinite(value)?[chart.convertToPixel({gridIndex:0},[i,value])]:[];
    }));
    return presentation?.echartsGeometry(chart,selectedRange.map(i=>chart.convertToPixel({xAxisIndex:0},i)),avoid);
  };
  clear.onclick=()=>{if(selectedRange)chart.setOption({tooltip:{showContent:true}});selectedRange=null;presenter?.clear();range.hidden=true;clear.hidden=true;chart.dispatchAction({type:"brush",areas:[]});};
  host.addEventListener("keydown",event=>{if(event.key==="Escape")clear.onclick();});
  const entries=new Map(series.map(s=>[s.key,new Map(s.points.map(p=>[p.date,p.value]))]));
  const escape=text=>String(text).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const fmt=v=>v==null?'미편입':`${Number(v).toLocaleString('ko-KR',{maximumFractionDigits:2})}%`;
    const seriesColor=key=>{const color=colors.get(key);if(document.documentElement.dataset.theme!=='dark'||!/^#[0-9a-f]{6}$/i.test(color))return color;return '#'+[1,3,5].map(i=>Math.round(parseInt(color.slice(i,i+2),16)*.65+255*.35).toString(16).padStart(2,'0')).join('');};
  function render(){
    const style=getComputedStyle(document.documentElement), dark=document.documentElement.dataset.theme==='dark';
    const token=(name,fallback)=>style.getPropertyValue(name).trim()||fallback;

    const text=token('--qs-text',dark?'#edf3f2':'#172126'),muted=token('--qs-muted',dark?'#a6b4b6':'#53646c'),border=token('--qs-grid',dark?'#364247':'#dce3e5');
    chart.setOption({animation:false,backgroundColor:'transparent',textStyle:{fontFamily:'Pretendard Variable, sans-serif',color:text},grid:{top:34,left:12,right:18,bottom:28,containLabel:true},tooltip:{trigger:'axis',confine:true,hideDelay:0,transitionDuration:0,className:'qe-point-tooltip',backgroundColor:token('--qs-raised',dark?'#222d42':'#e9eff7'),borderColor:border,textStyle:{color:text,fontSize:12},formatter:items=>{
      if(!Array.isArray(items))return escape(items.name||'')+' '+fmt(Array.isArray(items.value)?items.value[1]:items.value);
      const lines=items.filter(item=>item.seriesType==='line');
      return '<strong>'+escape(lines[0]?.axisValue??'')+'</strong>'+lines.map(item=>'<div>'+item.marker+escape(item.seriesName)+' <b>'+fmt(item.value)+'</b></div>').join('');
    },axisPointer:{type:'line'}},xAxis:{type:'category',data:dates,boundaryGap:false,axisLine:{lineStyle:{color:border}},axisTick:{show:false},axisLabel:{color:muted,hideOverlap:true,formatter:d=>d.slice(5),fontSize:12}},yAxis:{type:'value',min:0,name:'비중 (%)',nameTextStyle:{color:muted},axisLabel:{color:muted,fontSize:12,formatter:v=>`${v}%`},splitLine:{lineStyle:{color:border,type:'dashed'}}},dataZoom:[{type:'inside',disabled:true,start:zoom[0],end:zoom[1],filterMode:'none',preventDefaultMouseMove:false,zoomOnMouseWheel:false,moveOnMouseMove:false}],brush:{xAxisIndex:0,brushType:'lineX',brushMode:'single',transformable:false,toolbox:[],brushStyle:{color:'#69d3cf22',borderColor:'#69d3cf'}},toolbox:{show:false},series:series.flatMap(s=>[{id:s.key,name:s.fullLabel,type:'line',data:dates.map(d=>entries.get(s.key).get(d)??null),connectNulls:false,showSymbol:false,symbolSize:7,lineStyle:{width:s.key===selectedKey?2.8:1.8,color:seriesColor(s.key),type:s.isSparse?'dashed':'solid'},itemStyle:{color:seriesColor(s.key)},emphasis:{focus:'none'}},{id:s.key+'-events',name:s.fullLabel+' 신호',type:'scatter',data:s.signalPoints.filter(p=>Number.isFinite(p.value)).map(p=>({value:[p.date,p.value],name:p.actionLabel||p.kind,glyph:p.glyph||'',symbol:p.direction==='sell'?'triangle':'diamond',symbolRotate:p.direction==='sell'?180:0})),symbolSize:8,label:{show:true,formatter:p=>p.data.glyph,position:'top',fontSize:10,color:seriesColor(s.key)},itemStyle:{color:seriesColor(s.key)},tooltip:{formatter:p=>`${s.fullLabel}<br>${p.value[0]} · ${p.data.name}<br>${fmt(p.value[1])}`}}])},true);
    if(selectedRange){chart.setOption({tooltip:{showContent:false}});showRange(...selectedRange);}
  }
  chart.on('updateAxisPointer',event=>{const axis=event.axesInfo?.[0];if(!axis)return;const i=typeof axis.value==='number'?axis.value:dates.indexOf(axis.value);if(i>=0){selected=i;onObserve(dates[i]);}});
  chart.on('click',event=>{if(!event.seriesId)return;const s=series.find(s=>event.seriesId===s.key||event.seriesId===s.key+'-events');if(s){selectedKey=s.key;const date=Array.isArray(event.value)?event.value[0]:dates[event.dataIndex];onPin(date,s.key);}});
  chart.on('datazoom',()=>{const z=chart.getOption().dataZoom[0];zoom=[z.start,z.end];reset.hidden=zoom[0]<=0&&zoom[1]>=100;presenter?.place(geometry());});
  reset.onclick=()=>{zoom=[0,100];chart.dispatchAction({type:'dataZoom',start:0,end:100});host.focus();};
  const zoomAt=(factor,ratio=.5)=>{const span=Math.max(100/Math.max(2,dates.length-1),Math.min(100,(zoom[1]-zoom[0])*factor)),anchor=zoom[0]+ratio*(zoom[1]-zoom[0]);let start=Math.max(0,Math.min(100-span,anchor-ratio*span));chart.dispatchAction({type:'dataZoom',start,end:start+span});};
  host.addEventListener('wheel',event=>{event.preventDefault();const rect=host.getBoundingClientRect();zoomAt(event.deltaY<0?.8:1.25,Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)));},{passive:false});
  host.addEventListener('keydown',event=>{if(!['+','=','-','0'].includes(event.key))return;event.preventDefault();if(event.key==='0')reset.onclick();else zoomAt(event.key==='-'?1.25:.8);});

  function showRange(a,b){
    if(!selectedRange){chart.setOption({tooltip:{showContent:false}});chart.dispatchAction({type:'hideTip'});}
    [a,b]=[a,b].map(v=>Math.max(0,Math.min(dates.length-1,Math.round(v)))).sort((a,b)=>a-b);
    selectedRange=[a,b];
    if(presenter){
      const items=series.map(item=>{
        const values=entries.get(item.key),start=values.get(dates[a]),end=values.get(dates[b]);
        return {name:item.fullLabel||item.label,color:seriesColor(item.key),change:presentation.signedChange(Number.isFinite(start)&&Number.isFinite(end)?end-start:null,'%p'),detail:fmt(start)+' → '+fmt(end)};
      });
      presenter.show({start:dates[a],end:dates[b],items},geometry());
    }else{
    const period=document.createElement('strong');
    period.textContent=dates[a]+' → '+dates[b];
    const changes=series.map(item=>{
      const values=entries.get(item.key),start=values.get(dates[a]),end=values.get(dates[b]);
      const row=document.createElement('span'),label=document.createElement('span'),delta=document.createElement('b');
      label.textContent=item.fullLabel||item.label;
      if(Number.isFinite(start)&&Number.isFinite(end)){
        const change=end-start;
        delta.textContent=(change>0?'+':'')+change.toFixed(2)+'%p';
      }else delta.textContent='미제공';
      row.append(label,delta);
      return row;
    });
    range.replaceChildren(period,...changes);
    }
    range.hidden=false;clear.hidden=false;
    chart.dispatchAction({type:'brush',areas:[{brushType:'lineX',xAxisIndex:0,coordRange:[a,b]}]});
  }
  const coordinate=e=>{const rect=host.getBoundingClientRect();const value=chart.convertFromPixel({xAxisIndex:0},e.clientX-rect.left);return Math.max(0,Math.min(dates.length-1,Math.round(value)));};
  const move=(start,span)=>{span=Math.max(100/Math.max(2,dates.length-1),Math.min(100,span));start=Math.max(0,Math.min(100-span,start));chart.dispatchAction({type:'dataZoom',start,end:start+span});};
  const disposeDrag=directDrag(host,{dragging(active){chart.setOption({tooltip:{showContent:!active&&!selectedRange}});chart.dispatchAction({type:'hideTip'});},point:coordinate,select:showRange,clear:()=>clear.onclick(),view:()=>zoom.slice(),pan(dx,dy,v){move(v[0]-dx/(host.clientWidth||1)*(v[1]-v[0]),v[1]-v[0]);}});
  const touchCleanup=scope.QuantTouchChart?.bindTouchChart(host,{
    hit:(point,clamp)=>clamp||chart.containPixel({gridIndex:0},point)?coordinate({clientX:point[0]+host.getBoundingClientRect().left}):null,
    inspect:i=>{selected=i;onObserve(dates[i]);chart.dispatchAction({type:'showTip',seriesIndex:0,dataIndex:i});},
    compare:showRange,rangeReadout:()=>range,clear:()=>clear.onclick(),
    navigate:(a,b)=>scope.QuantTouchChart.navigateECharts(chart,a,b,100/Math.max(2,dates.length-1))
  });
  host.addEventListener('dblclick',reset.onclick);
  host.setAttribute('tabindex','0');host.setAttribute('role','group');
  const observer=new ResizeObserver(()=>{chart.resize();presenter?.place(geometry());});observer.observe(host);
  const theme=new MutationObserver(()=>render());theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  render();
  return {select(date,key){selected=dates.indexOf(date);selectedKey=key;host.setAttribute('aria-label',date+' · '+series.map(s=>`${s.fullLabel} ${fmt(entries.get(s.key).get(date))}`).join(', '));chart.dispatchAction({type:'downplay'});const i=series.findIndex(s=>s.key===key);if(i>=0)chart.dispatchAction({type:'highlight',seriesIndex:i*2});},ensureVisible(date){const i=dates.indexOf(date),pct=i/Math.max(1,dates.length-1)*100;if(pct<zoom[0]||pct>zoom[1]){const span=zoom[1]-zoom[0];chart.dispatchAction({type:'dataZoom',start:Math.max(0,pct-span/2),end:Math.min(100,pct+span/2)});}},destroy(){touchCleanup?.();disposeDrag();observer.disconnect();theme.disconnect();presenter?.destroy();chart.dispose();reset.remove();range.remove();clear.remove();}};
}};
})(window);
