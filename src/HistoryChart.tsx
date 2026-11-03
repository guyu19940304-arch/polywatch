import { useId } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { ChartNoAxesCombined } from 'lucide-react';
import { money } from './format';
type Point={timestamp:number;totalPnl:number|null;realizedPnl:number|null;unrealizedPnl:number|null};
export function combineHistory(series:Point[][]):Point[]{
  if(!series.length || series.some(s=>!s.length)) return [];
  const sorted=series.map(s=>[...s].sort((a,b)=>a.timestamp-b.timestamp));
  const start=Math.max(...sorted.map(s=>s[0].timestamp));
  const end=Math.min(...sorted.map(s=>s[s.length-1].timestamp));
  const times=[...new Set(sorted.flatMap(s=>s.map(p=>p.timestamp)))].filter(t=>t>=start&&t<=end).sort((a,b)=>a-b);
  const indices=sorted.map(()=>0);
  return times.map(timestamp=>{const points=sorted.map((s,i)=>{while(indices[i]+1<s.length&&s[indices[i]+1].timestamp<=timestamp)indices[i]++;return s[indices[i]];});const sum=(key:'totalPnl'|'realizedPnl'|'unrealizedPnl')=>points.some(p=>p[key]==null)?null:points.reduce((v,p)=>v+p[key]!,0);return {timestamp,totalPnl:sum('totalPnl'),realizedPnl:sum('realizedPnl'),unrealizedPnl:sum('unrealizedPnl')};});
}
export function HistoryChart({history,range,onRange,demo,baseline}:{history:Point[];range:string;onRange:(range:'1d'|'1w'|'1m'|'all')=>void;demo:boolean;baseline?:number}){
  const gradient=useId().replace(/:/g,'');
  const base=baseline??history[0]?.totalPnl;const plot=history.map(p=>({...p,totalPnl:p.totalPnl==null||base==null?null:p.totalPnl-base}));
  return <section className="panel chart-panel"><div className="panel-heading"><h2>盈亏曲线 <span>EQUITY CURVE</span></h2><div className="chart-actions"><span className="chart-legend"><i/>区间变化</span><div className="segmented" aria-label="盈亏时间范围">{[['1d','24h'],['1w','7day'],['1m','30day']].map(([key,label])=><button key={key} aria-pressed={range===key} className={range===key?'selected':''} onClick={()=>onRange(key as '1d'|'1w'|'1m')}>{label}</button>)}</div></div></div>
    <div className="chart-body">{history.length>1?<ResponsiveContainer width="100%" height="100%"><AreaChart data={plot} margin={{top:20,right:22,left:0,bottom:5}}><defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#70dda0" stopOpacity={.14}/><stop offset="100%" stopColor="#70dda0" stopOpacity={.01}/></linearGradient></defs><CartesianGrid stroke="#25302a" strokeDasharray="2 5"/><XAxis dataKey="timestamp" type="number" domain={['dataMin','dataMax']} tickFormatter={v=>range==='1d'?new Date(v*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}):new Date(v*1000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'})} axisLine={false} tickLine={false} minTickGap={45} tickMargin={12} tick={{fontSize:11,fill:'#8b988f'}}/><YAxis width={74} tickFormatter={v=>Math.abs(v)>=1000?`$${(v/1000).toFixed(1)}k`:`$${v}`} axisLine={false} tickLine={false} tickMargin={10} tick={{fontSize:11,fill:'#8b988f'}}/><ReferenceLine y={0} stroke="#4b594f" strokeDasharray="3 4"/><Tooltip labelFormatter={v=>new Date(Number(v)*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})} formatter={v=>[money(Number(v),true),'区间盈亏变化']} contentStyle={{background:'#18201b',border:'1px solid #a8874b',borderRadius:3,fontSize:12,color:'#e6eae5'}} itemStyle={{color:'#70dda0'}} cursor={{stroke:'#e3b45f',strokeDasharray:'3 3'}}/><Area type="linear" dataKey="totalPnl" stroke="#70dda0" strokeWidth={1.8} fill={`url(#${gradient})`} activeDot={{r:4,fill:'#e3b45f',stroke:'#111715',strokeWidth:2}} isAnimationActive={false} connectNulls={false}/></AreaChart></ResponsiveContainer>:<div className="empty"><ChartNoAxesCombined size={30}/><strong>暂无可用盈亏曲线</strong><span>等待官方快照，或当前周期缺少完整边界数据。</span></div>}</div><div className="chart-footnote"><span>{demo?'示例走势 · 静态数据':'相对周期起点的盈亏变化 · 曲线显示可用快照'}</span><span>USD · UTC+8</span></div></section>;
}
