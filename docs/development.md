# 开发与架构

## 目录

```text
public/                 HTML、CSS、浏览器 ESM；仅访问同源 /api/
src/domain/             日期、校验、匹配与提醒状态
src/application/        查询、分片采集、邮箱提醒、去重与投递
src/infrastructure/     官网、D1 快照、提醒存储、Brevo 适配
src/http/               查询/提醒路由、同源检查和安全响应
src/development/        仅本地使用的 Node SQLite D1 适配与迁移器
src/worker.mjs          Cloudflare HTTP 与三类 Cron 入口
server.mjs              本地启动；复用同一 HTTP 与后台应用层
migrations/             增量 SQL，生产由 Wrangler 执行
test/                   node:test；假网络、真 SQLite，无真实发信
scripts/                检查与部署自动化
docs/ui-preview/        独立设计稿及截图，不进入正式网站
```

运行时没有 npm 第三方包。直接开发依赖只有官方 Wrangler，并锁定版本和 lockfile。

## 数据路径

网页 → 同源 HTTP → 查询服务 → D1 快照。查询请求不直接抓取全市官网。连续入住缺少快照时只排队，后续由分片采集获取官方真实区间结果。

Cron → 持久租约 → 预算内共享采集 → 原子更新快照。列表按房源类型保存，单站日历跨类型共享；失败保留历史成功记录和时间，但过期值不会冒充当前计数。

已验证邮箱 → 到期提醒 → 新鲜观测 → 状态变化和加密 outbox 同一事务保存 → 独立租约发送与退避。失败、缺失、过期或部分空结果不等于明确无房。发送前检查条件版本、暂停/删除和新鲜度。

数据库保存验证/管理令牌摘要；仅待发邮件的加密 payload 暂时含实际链接，发送或失效后擦除。管理令牌只通过 URL fragment 交给前端，再用 Bearer 请求，不进入查询字符串。

## 状态与分母

- `not-open`：本地最小提前天数配置所指的未开放日期，具体规则以官方页面为准。
- `known` / 日历聚合 `open`：成功返回合法计数，0 是有效零值。
- `unknown`：缺失或异常计数、未采集、采集失败或过期；计数为 null。
- 部分总量为 null，`knownAvailableCount` 只表示已知下界。

`successfulStations + failedStations = totalStations` 是获取响应层面的覆盖；`unknownStations` 可能包含成功响应缺日期和失败，不能把它再次相加作分母。浏览器按所选日期及当前区域计算已知/总数。

## 验证原则

- 本地假网络测试覆盖语义、并发、重启恢复、SQL 原子性、token 隔离、预算和 HTTP 错误。
- 真实 HTTP 和官网查询单独记录；`npm test` 不会连接官网或发送真实邮件。
- 本地 SQLite、Wrangler 本地 Worker、Cloudflare 实际部署是三个不同验证环境，应分别报告结果。
- 密钥、完整管理链接和真实邮箱不出现在测试 fixture、截图或日志中。
- 公网发布、密钥接通与 Git 推送在可审查结果完成后由拥有者确认。
