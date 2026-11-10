import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('responsive trend preserves gaps, original weights, events and selected date',()=>{
 const handlers={},actions=[];let option;
 const el=()=>({className:'',hidden:false,setAttribute(){},addEventListener(){},before(){},after(){},append(){},remove(){},focus(){},querySelector:()=>el()});
 const chart={setOption(o){option=o;},on(k,f){handlers[k]=f;},dispatchAction(a){actions.push(a);},getOption(){return option;},resize(){},dispose(){}};
 const context={window:{echarts:{init:()=>chart}},document:{documentElement:{dataset:{theme:'dark'}},createElement:el},getComputedStyle:()=>({getPropertyValue:()=>''}),ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{observe(){}disconnect(){}}};
 vm.runInNewContext(fs.readFileSync(new URL('../assets/trend-chart.js',import.meta.url),'utf8'),context);
 const series=[{key:'A',fullLabel:'A',points:[{date:'2026-01-01',value:2},{date:'2026-01-03',value:3}],signalPoints:[{date:'2026-01-03',value:3,direction:'sell',actionLabel:'매도'}]}],before=JSON.stringify(series);let observed,pinned;
 const api=context.window.QuantETFTrend.mount(el(),{dates:['2026-01-01','2026-01-02','2026-01-03'],series,colors:new Map([['A','#3182f6']]),onObserve:d=>observed=d,onPin:(d,k)=>pinned=[d,k]});
 assert.deepEqual(Array.from(option.series[0].data),[2,null,3]);assert.equal(option.series[0].connectNulls,false);assert.equal(option.yAxis.min,0);assert.equal(option.series[1].data[0].symbolRotate,180);
 handlers.updateAxisPointer({axesInfo:[{value:1}]});assert.equal(observed,'2026-01-02');handlers.click({seriesId:'A',dataIndex:2,value:3});assert.deepEqual(pinned,['2026-01-03','A']);
 api.select('2026-01-03','A');assert.equal(JSON.stringify(series),before);assert(actions.some(a=>a.type==='highlight'));api.destroy();
});
