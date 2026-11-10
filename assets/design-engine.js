import {createEngine} from './quant-engine/engine/index.js';
const root=document.documentElement;
const readTheme=()=>root.dataset.theme==='dark'?'dark':'light';
const engine=createEngine(root,{theme:readTheme()});
root.dataset.quantEngineVersion='0.4.0';
new MutationObserver(()=>{const theme=readTheme();if(engine.getTheme()!==theme)engine.setTheme(theme);}).observe(root,{attributes:true,attributeFilter:['data-theme']});
window.quantDesignEngine=engine;

const aliases={'qd-bg':'bg','qd-surface':'surface','qd-surface-2':'raised','qd-text':'text','qd-muted':'muted','qd-border':'border','qd-accent':'accent','bg':'bg','panel':'surface','surface':'raised','text':'text','ink':'text','muted':'muted','line':'border','accent':'accent'};
for(const element of [root,document.body])for(const [alias,token] of Object.entries(aliases))element.style.setProperty('--'+alias,'var(--qe-'+token+')','important');


// One rendered row model supplies both the visible table and its CSV export.
const holdingsBody=document.querySelector('#top10-rows'),holdingsSearch=document.querySelector('#holdings-search'),holdingsReset=document.querySelector('#holdings-reset'),holdingsExport=document.querySelector('#holdings-csv');
if(holdingsBody&&holdingsSearch){
 const rows=()=>[...holdingsBody.rows].filter(r=>r.cells.length===8);
 const filter=()=>{const query=holdingsSearch.value.trim().toLocaleLowerCase();const all=rows();let count=0;for(const row of all){row.hidden=!!query&&!row.textContent.toLocaleLowerCase().includes(query);if(!row.hidden)count++;}holdingsReset.hidden=!query;document.querySelector('#holdings-count').textContent=`${count} / ${all.length}종목`;holdingsExport.disabled=count===0;};
 holdingsSearch.addEventListener('input',filter);holdingsReset.addEventListener('click',()=>{holdingsSearch.value='';filter();holdingsSearch.focus();});
 new MutationObserver(filter).observe(holdingsBody,{childList:true});filter();
 holdingsExport.addEventListener('click',()=>{const headers=[...holdingsBody.closest('table').querySelectorAll('thead th')].map(x=>x.textContent.replace(/[↕↑↓]/g,'').trim());const data=rows().filter(r=>!r.hidden).map(r=>[...r.cells].map(c=>(c.innerText||c.textContent).replace(/\s+/g,' ').replace(/(\d)pp\b/g,'$1%p').trim()));const quote=x=>'"'+(/^[=+@\-\t\r]/.test(x)?"'"+x:x).replace(/"/g,'""')+'"';const csv=[headers,...data].map(r=>r.map(quote).join(',')).join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));a.download=`etf-${document.querySelector('#hero-data-date').textContent}-filtered.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
}
