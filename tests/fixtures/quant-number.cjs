/* Quant display precision. Raw observations, calculations and input values stay unchanged. */
(function(scope){'use strict';
const cache=new Map();
function number(value,options={}){
 if(value===null||value===undefined||value===''||!Number.isFinite(Number(value)))return '—';
 let n=Number(value);if(Object.is(n,-0))n=0;
 const {locale='ko-KR',minimumFractionDigits,maximumFractionDigits,minimumSignificantDigits,maximumSignificantDigits,roundingIncrement,roundingPriority,trailingZeroDisplay,...rest}=options;
 const displayed=n*(rest.style==='percent'?100:1),tiny=Math.abs(displayed)>0&&Math.abs(displayed)<0.01;
 const precision=tiny?{minimumSignificantDigits:1,maximumSignificantDigits:2}:{minimumFractionDigits:0,maximumFractionDigits:2};
 const opts={...rest,...precision};const key=JSON.stringify([locale,opts]);
 let formatter=cache.get(key);if(!formatter){formatter=new Intl.NumberFormat(locale,opts);if(cache.size>96)cache.clear();cache.set(key,formatter)}
 return formatter.format(n);
}
const api={version:'1.0.0',number};scope.QuantFormat=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
