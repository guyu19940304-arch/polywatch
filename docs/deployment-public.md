# 部署与维护

镜像：`ghcr.io/guyu19940304-arch/polywatch:latest`。当前发布目标仅为 `linux/amd64`，请使用 Linux x86-64 主机和 Docker Compose v2。

## 配置与启动

```sh
git clone https://github.com/guyu19940304-arch/polywatch.git
cd polywatch
cp .env.example .env
```

编辑 `.env`，填写 1–10 个公开钱包地址，以英文逗号分隔：

```dotenv
# 填入需要持续采集的实际钱包地址；不可留空。
WATCH_WALLETS=
BIND_ADDRESS=127.0.0.1
PORT=8787
```

Compose 固定启用后台采集，并在 `WATCH_WALLETS` 为空时拒绝启动。`.env.example` 中的 `MONITOR_ENABLED=false` 只影响本地 npm 启动方式；本地需要持续采集时改为 `true`。`.env` 应留在部署机器上，不提交到源码仓库。

```sh
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 dashboard
```

服务器上可读取：

```sh
curl http://127.0.0.1:8787/api/health
curl http://127.0.0.1:8787/api/monitor
```

`/api/health` 表示服务能够响应，不代表上游数据完整或新鲜。`/api/monitor` 提供采集错误、更新时刻及补录状态。首次同步尚未保存钱包快照时，钱包接口会返回 `503 initial_sync`；后台继续同步，页面会重试。

## SSH 本地预览

默认端口只绑定服务器回环地址。在自己的电脑运行，将 `SERVER` 替换为服务器域名或地址、`USER` 替换为 SSH 用户：

```sh
ssh -N -L 8787:127.0.0.1:8787 USER@SERVER
```

保持 SSH 会话运行，在该电脑访问 [http://127.0.0.1:8787](http://127.0.0.1:8787)。如果本地 8787 已占用，可以使用：

```sh
ssh -N -L 8788:127.0.0.1:8787 USER@SERVER
```

然后访问 `http://127.0.0.1:8788`。这里无需开放服务器的 8787 公网入站端口。若修改了 `.env` 中的 `PORT`，同步修改转发命令右侧的远端端口。

项目没有账户系统或访问控制。需要多人或公网访问时，应在反向代理处配置认证和 HTTPS，再按部署环境调整监听地址。

## 数据与运行行为

| 项目 | 行为 |
| --- | --- |
| 交易采集 | 默认每 5 秒；网络异常时退避重试 |
| 盈亏与持仓快照 | 默认每 60 秒；官方观测可能更晚才更新 |
| 历史保留 | 固定滚动 30 天；读取时过滤、定期清理 |
| 持久化位置 | 容器 `/data/polywatch.sqlite`，由 `polywatch-data` 命名卷保存 |
| 首次启动 | 逐页补录 API 可服务的最近 30 天历史，期间保持最新页采集 |
| 上游不可用 | 显示最后保存的数据与原始来源时间，并标记异常 |
| 页面添加钱包 | 只修改浏览器关注列表，不修改后台 `WATCH_WALLETS` |

当前仓位及最新官方累计/周期摘要可以保留超过 30 天的统计含义；30 天限制针对本地原始历史明细与曲线。完整补录只表示公开 API 遍历状态，不保证所有链上成交均可取得。盈亏口径和窗口统计差异见 [README](../README.md#数据口径与限制)。

修改 `WATCH_WALLETS` 后运行 `docker compose up -d`，让 Compose 重新创建配置发生变化的服务。关闭浏览器不会停止容器采集；停止容器则会停止采集。浏览器关注列表保存在该浏览器本地。

## 更新、备份与停止

更新镜像：

```sh
docker compose pull
docker compose up -d
```

`latest` 会随发布变化；需要固定版本时，将 Compose 中的镜像引用改为已发布的版本标签或镜像摘要。

备份前暂停采集，并通过容器复制数据库；复制命令见 [Docker 官方说明](https://docs.docker.com/reference/cli/docker/compose/cp/)：

```sh
docker compose stop dashboard
docker compose cp dashboard:/data/. ./polywatch-backup/
docker compose start dashboard
```

备份包含钱包历史数据，应自行限制访问。维护前确认备份成功。恢复时先停止服务，将备份内容写回 `/data` 所在命名卷，并确保容器的 `node` 用户可读写，再启动服务。

停止服务：

```sh
docker compose down
```

此命令保留命名卷。`docker compose down -v` 会删除命名卷及其中的监控数据；仅在明确需要清空历史时使用。

## 常见检查

- **钱包配置报错**：检查 `WATCH_WALLETS` 是否为空、地址是否为 `0x` 开头的 42 位十六进制字符串，以及是否超过 10 个。
- **暂无盈亏或历史不完整**：确认使用正确的 Polymarket 代理钱包地址，再查看页面的数据边界说明及 `/api/monitor`。当前代码不把缺失值视为零。
- **采集持续失败**：查看容器日志及主机到 Polymarket 公开 API 的网络连接；保留现有数据库，等待重试或修复网络。
- **SSH 转发无法打开**：先在服务器本机检查健康接口，再检查本地端口是否占用以及 SSH 会话是否仍在运行。
