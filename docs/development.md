# 开发与架构

本页用于本地开发和验证。在线使用入口见[项目首页](../README.md)，接口约定见 [API 文档](api.md)。

## 本地启动

需要 Node.js **24.15 或更新版本**。在项目根目录运行：

```bash
npm start
```

打开终端显示的地址，默认是 `http://127.0.0.1:3000`。运行时只使用 Node 内置模块，无需先安装 npm 依赖。端口冲突时使用 `PORT=3001 npm start`；按 Ctrl+C 停止服务。

首次启动会自动创建 `.data/youth-inn.sqlite`，并依次应用尚未执行的数据库迁移。服务随后启动后台分片采集：先准备房源目录，再逐批读取站点日历；缺少连续入住结果时，查询只排队，后台再采集官方区间结果。页面会显示已有结果、采样时间及待确认部分，首次启动不保证立即覆盖所有站点。

本地后台任务在启动时执行一次，此后每分钟执行；每轮最多调用官网 20 次，并最多刷新一类目录。关闭浏览器不影响正在运行的本地服务；停止 Node 进程后，本地采集和提醒检查也停止。

## 开发与验证

```bash
npm run dev       # 代码变更时重启本地服务
npm run check     # JavaScript 语法、页面 ID 和应用入口检查
npm test          # 假网络、真 SQLite；不访问官网，不真实发信
```

需要官方 Wrangler 本机 Worker 模拟器时，再安装锁定的开发依赖：

```bash
npm ci
npm run preview:cloud  # 本机 Worker 模拟器
```

Node 本地服务使用 `.data/`；Wrangler 模拟器使用 `.wrangler/`；线上使用 Cloudflare D1。三者数据独立，不能用某一个环境的通过结果代替其他环境的验收。本机 Worker 的官网网络访问也可能与 Node 或真实云环境不同。

## 本地配置和状态

`npm start` 和 `npm run dev` 会读取可选的 `.env.local`。配置项模板见 [`.env.example`](../.env.example)；如需本地配置，可先复制模板并限制文件权限：

```bash
cp .env.example .env.local
chmod 600 .env.local
```

| 配置 | 本地行为 |
| --- | --- |
| `HOST` / `PORT` | 默认 `127.0.0.1` / `3000` |
| `PUBLIC_URL` | 邮件链接使用的本站来源；未设置时取实际本地地址，修改端口后也需同步修改显式配置 |
| `APP_SECRET` | 至少 32 字节；省略时自动生成并保存在 `.data/local-app-secret` |
| `BREVO_API_KEY` / `MAIL_FROM` | 可选的真实邮件配置；发件邮箱需在邮件服务中可用 |
| `ENABLE_MONITORING` | 设置为 `false` 时停止提醒检查，房源采集继续执行 |
| `INVITATION_REQUIRED` | 模板为 `true`；本地邀请数据也需要独立初始化 |

没有完整邮件配置时，查房仍可使用；创建提醒、验证邮箱和请求管理邮件不可用，不会假装发信。已有有效 Bearer 管理凭据的查看、修改、暂停和删除操作不依赖邮件配置。`/api/health` 的 `mailConfigured` 只表示配置校验通过，不证明邮件已经送达。填写真实邮件配置后，本地相关操作会真实发信；日常回归使用 `npm test`。

`.data/`、`.env.local` 和 `.wrangler/` 已被 Git 忽略。`.data/` 包含 SQLite、本地加密密钥，也可能包含私密邀请码文件；不要提交或放入截图、日志。数据库和对应密钥需一并保留，普通更新不要重建密钥，否则旧待发邮件可能无法解密。

本地数据库与线上 D1 不同步：线上邀请码、提醒和管理令牌不会自动出现在本机，管理链接只适用于签发它的站点。本地邀请初始化和文件保管见[邀请内测](invitations.md)；测试数据不要写入线上数据库。

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
scripts/                检查、私密邀请初始化与维护工具
docs/ui-preview/        独立设计稿及截图，不进入正式网站
```

运行时没有 npm 第三方包。直接开发依赖只有官方 Wrangler，并锁定版本和 lockfile。

## 数据路径

网页 → 同源 HTTP → 查询服务 → D1 快照。查询请求不直接抓取全市官网。连续入住缺少快照时只排队，后续由分片采集获取官方真实区间结果。

Cron → 持久租约 → 预算内共享采集 → 原子更新快照。列表按房源类型保存，单站日历跨类型共享；失败保留历史成功记录和时间，但过期值不会冒充当前计数。

受邀邮箱验证 → 到期提醒 → 新鲜观测 → 状态变化和加密 outbox 同一事务保存 → 独立租约发送与退避。失败、缺失、过期或部分空结果不等于明确无房。发送前检查条件版本、暂停/删除和新鲜度。

数据库保存验证/管理令牌摘要；仅待发邮件的加密 payload 暂时含实际链接，发送或失效后擦除。管理令牌只通过 URL fragment 交给前端，再用 Bearer 请求，不进入查询字符串。

## 状态与分母

- `not-open`：本地最小提前天数配置所指的未开放日期，具体规则以官方页面为准。
- `known` / 日历聚合 `open`：成功返回合法计数，0 是有效零值。
- `unknown`：缺失或异常计数、未采集、采集失败或过期；计数为 null。
- 部分总量为 null，`knownAvailableCount` 只表示已知下界。

执行站点观测时，`successfulStations + failedStations = totalStations` 是获取响应层面的覆盖；`unknownStations` 可能包含成功响应缺日期和失败，不能把它再次相加作分母。`not-open` 日期另用 `notOpenStations` 表示，未执行可用性观测。浏览器按所选日期及当前区域计算已知/总数。字段说明见 [API 数据语义](api.md#数据语义)。

## 验证原则

- 本地假网络测试覆盖语义、并发、重启恢复、SQL 原子性、token 隔离、预算和 HTTP 错误。
- 真实 HTTP 和官网查询单独记录；`npm test` 不会连接官网或发送真实邮件。
- 本地 SQLite、Wrangler 本地 Worker、Cloudflare 实际部署是三个不同验证环境，应分别报告结果。
- 密钥、完整管理链接和真实邮箱不出现在测试 fixture、截图或日志中。
- 公网发布、密钥接通与 Git 推送在可审查结果完成后由拥有者确认。

## 维护者参考

- [重构决策与验收记录](refactor-plan.md)
- [部署、云端采样与恢复记录](deployment.md)
- [邀请初始化与成员规则](invitations.md)
