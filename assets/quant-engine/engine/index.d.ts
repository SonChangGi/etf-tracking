export type Theme = 'dark'|'light';
export interface Meta { title:string; description?:string; source?:string; unit?:string;dataState?:'observed'|'simulated'|'forecast';asOf?:string }
export interface Series { id?:string; name:string; data:(number|null)[]; visible?:boolean;dashed?:boolean;color?:string }
export type ChartSpec = Meta & (
 {kind:'line'|'area'|'small-multiples';x:string[];series:Series[];brush?:boolean;zoom?:boolean;xLabel?:string;yLabel?:string} |
 {kind:'bar'|'diverging';rows:{name:string;value:number|null}[]} |
 {kind:'slope'|'dumbbell';rows:{name:string;start:number;end:number}[];startLabel?:string;endLabel?:string} |
 {kind:'scatter';points:{name:string;x:number;y:number;group?:string}[];xLabel?:string;yLabel?:string} |
 {kind:'heatmap';x:string[];y:string[];values:[number,number,number|null][];symmetric?:boolean} |
 {kind:'boxplot';rows:{name:string;values:[number,number,number,number,number]}[]} |
 {kind:'histogram';bins:{start:number;end:number;count:number}[]} |
 {kind:'waterfall';initial?:number;verifyTotals?:boolean;rows:{name:string;value:number;type?:'delta'|'total'}[]} |
 {kind:'range';rows:{name:string;low:number;high:number;value?:number|null}[]} |
 {kind:'calendar';values:[string,number|null][];range?:string|[string,string]} |
 {kind:'fan';x:string[];observed:(number|null)[];center:(number|null)[];forecastStart:number;intervalKind:'prediction'|'confidence'|'scenario';method:string;intervals:{level:number;low:(number|null)[];high:(number|null)[]}[]} |
 {kind:'bullet';rows:{name:string;value:number;target:number;ranges:[number,number,number]}[]} |
 {kind:'treemap';nodes:TreeNode[]}
);
export interface TreeNode {name:string;value?:number;children?:TreeNode[]}
export interface MetricSpec extends Meta {kind:'metric';value:number|null;precision?:number;history?:(number|null)[];comparison?:{value:number;label:string;mode:'absolute'|'relative';desirable:'higher'|'lower'|'neutral'}}
export interface DesignConfig {density:'comfortable'|'compact';corners:'soft'|'square';accent:'cyan'|'blue'|'violet'}
export interface Column {key:string;label:string;type:'text'|'number'|'percent'|'sparkline'|'bar';unit?:string;group?:string}
export interface TableSpec extends Meta {kind:'table';id?:string;columns:Column[];rows:({id:string|number}&Record<string,unknown>)[];variant?:'standard'|'ranked'|'grouped'|'matrix';rowGroup?:string;pageSize?:number;rankBy?:string;rankDirection?:'asc'|'desc'}
export interface StatusSpec extends Meta {kind:'status';state:'loading'|'empty'|'error'}
export type Spec=ChartSpec|TableSpec|StatusSpec|MetricSpec;
export interface Events {onLegendChange?:(visible:Record<string,boolean>)=>void;onSelect?:(selection:unknown|null)=>void;onRange?:(range:unknown|null)=>void;onRetry?:()=>void}
export interface View {update(spec:Spec):void;destroy():void;getState():unknown;element:HTMLElement;renderer:unknown}
export interface Engine {mount(host:HTMLElement,spec:Spec,events?:Events):View;setTheme(theme:Theme):void;getTheme():Theme;configure(config:Partial<DesignConfig>):DesignConfig;getDesign():DesignConfig;destroy():void}
export function createEngine(root:HTMLElement,options?:{theme?:Theme;echarts?:unknown;design?:Partial<DesignConfig>}):Engine;
export function validateSpec(spec:Spec):Spec;
export const themes:Record<Theme,Record<string,string|string[]>>;
export const CHART_KINDS:readonly string[];

export function metricChange(spec:MetricSpec):null|{value:number|null;tone:'positive'|'negative'|'neutral';unit?:string;reason?:string};
export function rebaseComparison(spec:Extract<ChartSpec,{kind:'line'|'area'|'small-multiples'}>,start?:number,end?:number,base?:number):ChartSpec;
export function contrastRatio(foreground:string,background:string):number;
export const designDefaults:Readonly<DesignConfig>;
export const designPresets:Readonly<Record<keyof DesignConfig,readonly string[]>>;
