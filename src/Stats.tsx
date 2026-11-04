import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { money, tone } from './format';

function Metric({ value, signed = true, primary = false }: { value: number | null; signed?: boolean; primary?: boolean }) {
  const previous = useRef(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const hadValue = previous.current != null;
    const differs = previous.current !== value;
    previous.current = value;
    setChanged(false);
    if (!hadValue || value == null || !differs) return;
    setChanged(true);
    const timer = setTimeout(() => setChanged(false), 900);
    return () => clearTimeout(timer);
  }, [value]);
  return <span className={`${primary ? 'stat-value' : 'stat-secondary-value'} ${signed ? tone(value) : ''} ${changed ? 'metric-updated' : ''}`}>{money(value, signed)}</span>;
}

export function Stats({ summary, periodLabel, allPnl }: { summary: { totalPnl: number | null; realizedPnl: number | null }; periodLabel: string; allPnl: number | null }) {
  return <section className="stats-band panel" aria-label="盈亏统计">
    <div className="stats-heading"><h1>总盈亏 <span>PORTFOLIO P&L</span></h1><span className="stats-period">{periodLabel} / USD</span></div>
    <div className="stats-main"><div className="stat-primary"><Metric value={summary.totalPnl} primary/><span className="stat-note">所选官网周期的交易盈亏变化<ArrowUpRight size={13}/></span></div><div className="stat-secondary"><span className="stat-label" title="官方净已实现仓位盈亏变化，与官网图表总额采用不同口径，不可作为其拆分项相加">已实现仓位盈亏变化</span><Metric value={summary.realizedPnl}/><span className="stat-note">Net realized P&L Δ</span></div></div>
    <div className="stats-bottom"><span>历史累计 <b className={tone(allPnl)}>{money(allPnl, true)}</b></span></div>
  </section>;
}
