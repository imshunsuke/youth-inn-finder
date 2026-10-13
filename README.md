# 青年驿站 · 上海

公开查询上海青年驿站的日期与连续入住房源，收藏驿站，并通过验证邮箱建立有房提醒。查房无需注册；申请和审核继续在官网完成。

米白与森林绿的响应式界面，保留欢迎插画，查询和房源列表保持简洁。数据来自[上海青年驿站](https://qnyz.shyouth.net/TWYouthInnV2/static/onemap/index.html)公开查询接口。

试用网站：[youth-inn-finder.imshunsukez.workers.dev](https://youth-inn-finder.imshunsukez.workers.dev)。已部署到 Cloudflare，真实查房、邮箱验证和后台有房通知已跑通。

## 本地启动

安装 Node.js 24.15 或更新版本后：

```bash
npm start
```

打开终端显示的地址，默认 `http://127.0.0.1:3000`。无需安装运行时依赖。首次运行会自动创建本地数据库并分批收集房源，页面会自动更新；没有配置邮件服务时，提醒入口会明确显示暂不可用，不会假装发送邮件。

```bash
npm ci                 # 安装官方 Wrangler 开发工具
npm run dev            # 本地开发，代码变更重启服务
npm run check          # 语法、页面 ID 与入口检查
npm test               # 无网络、无真实发信的测试
npm run deploy -- --dry-run  # 打包检查，不发布
```

本地状态在被 Git 忽略的 `.data/`，包含 SQLite 和本地加密密钥；请一并保留，不要提交。端口冲突时使用 `PORT=3001 npm start`。Ctrl+C 停止服务。

## 功能

- 未来 21 天日历，默认选择最早可查询日期；单日、连续入住使用不同的官方查询结果。
- 区域、关键词、房源类型、上架状态、最低房数、数量与距离排序。
- 收藏保存在当前浏览器；定位需点击授权，展示直线距离。
- 详情链接前往官方页面，不代提交入住申请。
- 提醒采用邮箱验证和专属管理链接，无密码账户；可以暂停、恢复、修改条件和取消。
- 每条已验证提醒计划每 15 分钟检查，首次有符合结果提醒一次；持续有房不重复，明确无房后再次有房再提醒。
- 后台集中采集、持久去重、邮件失败重试和发送预算；关闭浏览器后仍可运行。

**房源未知不等于无房。** 官方未返回日期、失败或过期数据显示待确认；部分结果仅展示已确认数量的下界及覆盖率。数量不是“新发布”标志，也不保证申请成功。

## 部署与邮件

推荐 Cloudflare Workers + D1 + 原生 Cron，Brevo HTTP API 发信。生产运行时使用 Web 标准 API，无第三方运行时包；Wrangler 是唯一直接开发依赖。

1. 注册并验证 [Cloudflare](https://dash.cloudflare.com/sign-up) 和 [Brevo](https://onboarding.brevo.com/account/register)，先选免费档。
2. 按[部署说明](docs/deployment.md)完成一次账号授权、发信身份验证和安全密钥配置。
3. 运行 `npm run deploy`；配置完成后可以用同一命令更新。

**已公开部署并完成真实邮件验收。** 拥有者已确认收到验证邮件和后台自动有房通知，测试提醒已按要求暂停。云端已成功读取真实官网目录和全部个人房源站点快照；免费 CPU 稳定性仍在验证，不能以少量成功请求代替完整规模验收。涉及域名购买或付费升级时先确认。

免费规模采用有上限的任务批次，保护官方接口和平台额度；不能保证任意数量的不同入住区间都能即时更新。具体首发提醒范围见[重构方案](docs/refactor-plan.md)，上线前确认。

## API 与工程

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 服务版本、邮件配置状态 |
| `GET /api/calendar` | 日历和站点级可用性 |
| `GET /api/available` | 单日或真实连续入住余房；缺少快照时排队采集 |
| `GET /api/nearest` | 按直线距离排列站点 |
| `POST /api/reminders` | 创建待验证提醒 |
| `POST /api/reminders/verify` | 用户确认后验证邮箱 |
| `POST /api/reminders/access` | 发送专属管理链接 |
| `GET /api/reminders` | 通过 Bearer 管理令牌查看自己的提醒 |
| `PATCH /api/reminders/:id` | 修改条件、暂停或恢复 |
| `DELETE /api/reminders/:id` | 用户确认后删除提醒 |

查询支持 `houseType`、`onlyOnShelf`、`district`、`q`、`stationId`、`minCount`、`limit`、`sort`，距离查询需要同时提供 `lat/lon`。日历使用 `startDate/days`，可用房源使用 `date/endDate`。所有查询固定上海业务日期，返回采样时间、部分结果标志和覆盖率。

日历可传 `includeDayItems=false` 省略各日期重复的房源详情；站点、日聚合和未知状态保持一致。默认 `true` 保留完整 API 行为，网页使用精简模式。

- [开发与架构](docs/development.md)
- [重构决策与验收记录](docs/refactor-plan.md)
- [可双击打开的设计原型](docs/ui-preview/index.html)（虚构数据，仅用于设计对照）

只调用官网列表/日历 GET 和连续入住余房 POST，不调用登录、申请提交或数据修改接口。

[Apache-2.0](LICENSE) © 2026 Shunsuke
