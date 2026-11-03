export const money = (value: number | null | undefined, signed = false) => value == null || !Number.isFinite(value) ? '—' : `${signed && value > 0 ? '+' : value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}`;
export const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('en-US',{maximumFractionDigits:2});
export const short = (value: string) => `${value.slice(0,6)}…${value.slice(-4)}`;
export const tone = (value: number | null | undefined) => value == null || value === 0 ? '' : value > 0 ? 'positive' : 'negative';
export const dateTime = (value: number | string | null | undefined) => value == null ? '等待数据' : new Date(typeof value==='number'?value*1000:value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
export const marketUrl = (row: {eventSlug?: string | null;slug?: string | null}) => row.eventSlug ? `https://polymarket.com/event/${encodeURIComponent(row.eventSlug)}` : row.slug ? `https://polymarket.com/market/${encodeURIComponent(row.slug)}` : null;
