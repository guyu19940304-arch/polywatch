# 只读监控 API

核实日期：2026-11-04。上游为 [Polymarket 官方 Data API V2](https://data-api.polymarket.com/v2/docs)，无需私钥、钱包签名或 API Key。

## 本地接口

服务默认监听 `127.0.0.1:8787`，生产模式同时提供 `dist/` 页面。钱包只能从部署环境 `WATCH_WALLETS` 读取；名单外的钱包拒绝访问，无配置写入接口。

| GET 路径 | 返回内容 |
| --- | --- |
| `/api/health` | 进程健康，不代表上游可达或数据完整 |
| `/api/monitor` | 部署钱包名单、目标采集间隔、最近采集时间及错误 |
| `/api/wallet/:address?range=1d` | 钱包快照；range 支持 `1d`、`1w`、`1m`、`all` |
| `/api/wallet/:address/activity?cursor=...` | 每页 100 条活动；继续加载使用返回的 `pagination.nextCursor` |
| `/api/wallet/:address/window/:conditionId` | 单窗口 OPEN/CLOSED 持仓分页核验、汇总盈亏及完整性 |

地址应为 Polymarket 个人资料的代理钱包地址。`conditionId` 为 `0x` 加 64 位十六进制。采集器运行时读本地 SQLite；首份快照尚未取得时返回 `503 initial_sync`，后台继续采集。无效参数返回 400，名单外地址返回 403。前台模式中上游限流返回 429，网络故障返回 502。错误与缺失金额不转成零或演示数据。

## 盈亏字段

- `summary.totalPnl`：`/v2/user-stats` 的 `all_time_pnl.trade_pnl`，对应官网个人主页累计图表。官方定义为 `position_pnl - realized_lp_pnl + fees_charged - fees_refunded`；直接读取字段，不重复扣费。
- `summary.realizedPnl` / `unrealizedPnl`：官方净仓位指标，用于独立展示。它们的和是 `position_pnl`，不是官网 `trade_pnl`，不能当作图表总额的拆分项。`economicPnl` 与 `walletIncome` 也不混入主统计。
- `period.totalPnl`：官网所选周期累计序列的首尾差。`1d/1h`、`1w/3h`、`1m/18h` 对应官网 1D、1W、1M；不会从 ALL 曲线截取固定秒数重算。1D 网格可能只有 23 小时首尾跨度，以 `period.start/end` 为准。
- `periods`：同时提供三个周期；`historyByRange` 保留各自网格，避免前端切换周期使用不同取样点。ALL 金额直接取累计摘要，本地 ALL 曲线仍只保留最近 30 天。
- `pnlBasis` / `historyPnlBasis` / `summary.pnlBasis`：新图表为 `polymarket-trade-pnl`；旧库 `polymarket-position-pnl` 隔离保存，升级后等待新口径采集，不能混用、求差或失败回退。
- `period.complete=false` 表示缺失所需金额，主金额为 `null`。辅助金额缺失不会使已知的主金额失效。曲线缺失值中断，不插值为零。
- `observedAt` 是上游实际观测时间，`fetchedAt` 是本次获取时间，网格 `timestamp` 不是新鲜度证明。延迟判定按官方 `sourceFidelity` 设置容忍时间（日频为 48 小时）；网络错误与本地采集停滞仍独立显示。

`timestamp`、`observedAt` 为 Unix 秒；`fetchedAt` 为 ISO 时间。采集器状态中的时间为毫秒。显示的时间范围和源频率说明不可省略。

官网页面自身也可能命中缓存。核对时应记录官网及 API 的取样首尾、原始观测时间与获取时间；整点更新后，不同缓存仍可能短暂显示上一组区间。不要为了匹配旧页面金额而改用错误公式。

## 窗口与交易

窗口按官方 `conditionId` 聚合双方 outcome，先按 token 去重；较新 `last_event_at` 优先，同时间当前持仓优先。每个窗口是全生命周期仓位盈亏，不是所选周期的增量，也不能用窗口合计代替账户图表统计。BTC 5m 使用 `btc-updown-5m-<unix秒>` slug 识别，不猜测标题。

全局 OPEN/CLOSED 列表有分页与时间预算。`coverage.complete=false` 可表示正常分页截断、30 天保留范围或错误；`coverage.error` 专门表示实际请求故障。单窗口核验独立遍历两侧，成功后 `complete=true` 仅承诺官方可服务数据分页完整，不保证上游无延迟。

交易金额使用官方现金字段，不用 `price × size` 重算。活动包含成交、赎回、拆分、合并及其他官方事件。内容相同的多次成交保留重复次数；不能仅按交易哈希去重。活动游标不透明，前台上游游标和持久化本地签名游标不可混用。

## 采集、保留与提示

后台默认交易 5 秒、快照 60 秒；网络异常退避重试。关闭网页不停止后台。相同进行中的请求合并，缓存有数量限制；OPEN/CLOSED 共用一组缓存寿命。响应时间不等于链上实时保证。

同口径的部分请求失败可保留上一次成功内容、来源时间及错误状态；不跨盈亏口径保留旧金额。读取本地数据不会刷新其来源时间。最近 30 天明细与曲线保留策略、文件布局和离线压缩见 [存储维护](storage.md)。

提醒面板只展示当前故障、明确延迟与近 5 分钟大额成交。故障恢复自动消失，大额成交到期自动移出并标记为非异常。正常分页预算和保留范围留在数据说明中，不作为常驻故障。

`npm test` 覆盖统计口径、分周期网格、空值、分页、重复成交、缓存隔离、旧库迁移、断网恢复、只读权限及提醒生命周期；数据核验还需同一时间读取官网，不能只凭单元测试推断金额正确。
