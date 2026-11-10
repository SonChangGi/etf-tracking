import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('responsive trend preserves gaps, original weights, events and selected date',()=>{
 const handlers={},actions=[];let option;
 const el=()=>({className:'',hidden:false,style:{},dataset:{},removeEventListener(){},setAttribute(){},addEventListener(){},before(){},after(){},append(){},remove(){},focus(){},querySelector:()=>el()});
 const chart={setOption(o){option=o;},on(k,f){handlers[k]=f;},dispatchAction(a){actions.push(a);},getOption(){return option;},resize(){},dispose(){}};
 const context={window:{echarts:{init:()=>chart}},document:{documentElement:{dataset:{theme:'dark'}},createElement:el},getComputedStyle:()=>({getPropertyValue:()=>''}),ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{observe(){}disconnect(){}}};
 vm.runInNewContext(fs.readFileSync(new URL('../assets/trend-chart.js',import.meta.url),'utf8'),context);
 const series=[{key:'A',fullLabel:'A',points:[{date:'2026-01-01',value:2},{date:'2026-01-03',value:3}],signalPoints:[{date:'2026-01-03',value:3,direction:'sell',actionLabel:'매도'}]}],before=JSON.stringify(series);let observed,pinned;
 const api=context.window.QuantETFTrend.mount(el(),{dates:['2026-01-01','2026-01-02','2026-01-03'],series,colors:new Map([['A','#3182f6']]),onObserve:d=>observed=d,onPin:(d,k)=>pinned=[d,k]});
 assert.deepEqual(Array.from(option.series[0].data),[2,null,3]);assert.equal(option.series[0].connectNulls,false);assert.equal(option.yAxis.min,0);assert.equal(option.series[1].data[0].symbolRotate,180);
 handlers.updateAxisPointer({axesInfo:[{value:1}]});assert.equal(observed,'2026-01-02');handlers.click({seriesId:'A',dataIndex:2,value:3});assert.deepEqual(pinned,['2026-01-03','A']);
 api.select('2026-01-03','A');assert.equal(JSON.stringify(series),before);assert(actions.some(a=>a.type==='highlight'));api.destroy();
});
test('default drag reports chronological percentage points with zero and missing endpoints',()=>{
 const events={},outputs=[],actions=[];let option;
 const el=tag=>{const e={style:{},dataset:{},hidden:false,clientWidth:300,setAttribute(){},addEventListener(k,f){(events[k]??=[]).push(f);},removeEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),before(){},after(){},append(){},remove(){},focus(){}};if(tag==='output')outputs.push(e);return e;};
 const chart={setOption(o){option=o;},on(){},dispatchAction(a){actions.push(a);},convertFromPixel:(_,v)=>v/100,getOption:()=>option,resize(){},dispose(){}};
 const ctx={window:{echarts:{init:()=>chart}},document:{documentElement:{dataset:{theme:'dark'}},createElement:el},getComputedStyle:()=>({getPropertyValue:()=>''}),ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{observe(){}disconnect(){}}};vm.runInNewContext(fs.readFileSync(new URL('../assets/trend-chart.js',import.meta.url),'utf8'),ctx);
 const dates=['2026-01-01','2026-01-02','2026-01-03'];const series=[{key:'A',fullLabel:'A',points:dates.map((date,i)=>({date,value:i})),signalPoints:[]},{key:'B',fullLabel:'B',points:[{date:dates[2],value:3}],signalPoints:[]}];ctx.window.QuantETFTrend.mount(el(),{dates,series,colors:new Map([['A','#3182f6'],['B','#ff0000']]),onObserve(){},onPin(){}});
 const fire=(k,x,y=0,extra={})=>(events[k]||[]).forEach(f=>f({clientX:x,clientY:y,pointerId:1,button:0,preventDefault(){},stopImmediatePropagation(){},...extra}));
 fire('pointerdown',0);fire('pointermove',200);assert.equal(outputs[0].textContent,'2026-01-01 → 2026-01-03 · A 2.00%p · B 미제공');fire('pointerup',200);fire('pointerdown',200);fire('pointermove',0);assert.equal(outputs[0].textContent,'2026-01-01 → 2026-01-03 · A 2.00%p · B 미제공');fire('pointerup',0);fire('keydown',0,0,{key:'Escape'});assert(outputs[0].hidden);
 fire('pointerdown',0,0,{pointerType:'touch'});fire('pointermove',4,50,{pointerType:'touch'});assert(outputs[0].hidden,'vertical touch remains page scroll');
 assert(!actions.some(a=>a.type==='dataZoom'),'vertical gesture leaves the time window alone');
});
