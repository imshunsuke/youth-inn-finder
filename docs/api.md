# API

网页使用同源 `/api/`。公开查询无需账户；提醒使用邀请码、邮箱验证和 Bearer 管理凭据。在线入口见[项目首页](../README.md)，本地运行见[开发文档](development.md)。

## 接口

| 接口 | 用途与返回 |
| --- | --- |
| `GET /api/health` | 版本、时间、邮件配置与邀请模式；也支持 `HEAD` |
| `GET /api/calendar` | 日历聚合、各站日期可用性，返回 `{ startDate, days, stations, meta }` |
| `GET /api/available` | 单日或真实连续入住的已知可用房源，返回 `{ data, meta }` |
| `GET /api/station` | 按 `stationId` 和可选 `houseType` 读取单站完整详情 |
| `POST /api/collection` | 无参数、无请求体，补查已入队任务；固定最多 6 次官网请求 |
| `GET /api/nearest` | 按直线距离排列目录中的站点，返回 `{ data, meta }`；不代表这些站点有房 |
| `POST /api/reminders` | 新建提醒；邀请模式下需有效邀请码或已绑定成员的 Bearer 凭据 |
| `POST /api/reminders/verify` | 主动确认验证邮件中的令牌，启用提醒并返回管理令牌 |
| `POST /api/reminders/access` | 请求管理邮件；始终返回统一受理提示，不公开成员资格 |
| `GET /api/reminders` | Bearer 授权后查看自己的已验证、启用或暂停提醒 |
| `PATCH /api/reminders/:id` | Bearer 授权后修改自己的条件、暂停或恢复 |
| `DELETE /api/reminders/:id` | Bearer 授权后删除自己的提醒；网页执行前要求确认 |

查房和详情接口只支持 `GET`；补查仅接受无请求体的 `POST /api/collection`。带请求体的提醒写入请求使用 `Content-Type: application/json`，请求体最大 8 KiB；提醒请求携带 `Origin` 时必须来自本站。不要把邀请码或管理令牌放入查询字符串。

## 查询参数

| 参数 | 默认值与含义 |
| --- | --- |
| `houseType` | `0`：个人申请；`1`：全部房源 |
| `onlyOnShelf` | `false`；设为 `true` 时只保留明确上架的站点 |
| `district` | 区域名称精确匹配 |
| `q` | 关键词，匹配站名、地址、区域或街道；最多 100 字；兼容别名 `keyword` |
| `stationId` | 单个站点 ID；兼容别名 `houseId` |
| `minCount` | `1`；整数 `1–10000`，筛选至少有这些房数的站点 |
| `limit` | `20`；整数 `1–200`，限制 `available` 和 `nearest` 的 `data` 条数；不截断日历的站点集合 |
| `sort` | 无坐标时为 `availability`，有坐标时为 `distance`；还支持 `name` |
| `lat` / `lon` | 必须同时提供；纬度 `[-90,90]`，经度 `[-180,180]`；`nearest` 必填，距离排序也需要坐标 |
| `startDate` / `days` | `calendar` 使用；起始日默认上海今天，天数默认 `21`，整数 `1–31`；起始日兼容 `date` |
| `includeOfficialDetails` | 默认 `true`；`false` 省略列表中较大的 `officialUrl`，可通过 `GET /api/station?stationId=…` 按需获取 |
| `includeDayItems` | `calendar` 默认 `true`；`false` 省略重复的 `days[].items`，站点、聚合和未知状态不变 |
| `date` / `endDate` | `available` 使用；入住日默认上海今天，可选离店日，格式均为 `YYYY-MM-DD`；离店必须晚于入住 |

未知参数或重复的同名参数返回 `400 INVALID_INPUT`。整数参数不接受小数或科学计数法。`sort=availability` 按已知余房数降序，`distance` 按直线公里数升序。

只读示例：

```text
/api/calendar?days=21&includeDayItems=false&houseType=0
/api/nearest?lat=31.23&lon=121.47&limit=5
```

连续入住的 `endDate` 是不含离店当天的结束日期，原样传给官方区间查询；结果不由逐日日历的最小值推算。需要入队采集的区间限制为未来 90 天内入住、最多 30 晚。单日和日历未返回的日期仍是未知，不推算余房。

## 数据语义

所有业务日期固定使用 `Asia/Shanghai`；采样时间返回 ISO 时间戳。API 默认从上海今天起算，当前本地规则要求至少提前 2 天，较早日期标记为 `not-open`；网页默认选择最早可查询日期。该规则是应用配置，具体开放规则以官网为准。

| 状态 | 含义 |
| --- | --- |
| `known` | 站点返回合法非负整数；`0` 是明确无房 |
| 日历聚合 `open` | 该日所有目标站点的计数已知，聚合可用；不保证存在正数房源 |
| `unknown` | 无法取得该日期的有效计数，例如日期缺失、异常计数、快照未采集或过期；计数为 `null` |
| `not-open` | 应用最小提前天数规则内的未开放日期；计数为 `null` |
| 可用房源聚合 `partial` | 存在未知站点，`data` 只包含已确认且满足最低房数的结果 |

日历在覆盖不全时，`availableCount` 和 `stationCount` 为 `null`；`knownAvailableCount`、`knownStationCount` 仅为满足筛选条件的已知下界。未知不等于 0，部分空列表也不能证明全市无房。`limit` 截断后的 `data.length` 不等于所有匹配站点数，可结合 `meta.matchedStations` 查看截断前数量。

`meta` 保留数据时间和覆盖率：

- `generatedAt`：本次响应生成时间；`fetchedAt`、`oldestFetchedAt`、`latestFetchedAt`：成功样本时间范围，包含目录时间，不表示一次原子采样。
- `availabilityFetchedAt`：当前站点新鲜观测中的最早时间；没有站点观测时为 `null`。
- `partial`：存在未知或不完整结果；`pending`：存在缺失、过期或无效的持久快照。新鲜日历缺少某个日期也可能 `partial=true`、`pending=false`。
- `coverage`：执行站点观测时，`successfulStations + failedStations = totalStations`；`unknownStations` 与失败有交集，不能再次相加作分母。未开放日期另有 `notOpenStations`。
- `snapshotCoverage`：快照层面的新鲜、缺失、过期和无效数量；`lastFailedStations` 是另外的历史失败指标，也不能重复加入分母。

HTTP 响应读取持久快照，不等待全市逐站查询。缺少目录时返回 `503 SNAPSHOT_PENDING`，过期目录返回 `503 SNAPSHOT_STALE`；缺少部分站点快照时可返回 `200` 和部分结果。缺少连续入住快照时会有限入队，`meta.collection` 说明是否已排队或容量受限。线上返回固定的 `meta.collection.advanceUrl`。客户端用无请求体的 `POST /api/collection` 启动一次最多 6 个驿站的独立补查，再读查询结果；不会在一次调用里同时解析全市目录和采集。按 `Retry-After` 或 `meta.refreshAfterMs` 等待，按需补查时为 10 秒，目录准备等情况为 60 秒。不保证立即完成；默认快照满 20 分钟后视为过期。

区间查询只为缺失、过期或无效快照的站点入队，成功的普通查询任务释放名额并保留快照；提醒任务仍定期刷新。`collection.requested` 是本次仍需更新的站点数，`accepted` 包括新入队和已有的待处理任务。`status=capacity-limited` 表示其中有站点未能入队，即使 `accepted` 大于 0；`queued` 表示待更新站点全部已排队。HTTP `200` 和 `pending=true` 只表示返回了部分结果，不能据此断言后台正在执行该查询。页面展示 `snapshotCoverage.freshStations/totalStations` 的快照更新进度；失败、排队和未入队分别提示，参数错误不会自动无限重试。

## 提醒授权与条件

当前在线服务采用[邀请内测](invitations.md)：5 个邮箱，每人最多 2 条占位提醒，总上限 10 条。启用、暂停和最近 30 分钟更新的待验证提醒占名额；已取消、到期或过期的待验证提醒不占份数。

`POST /api/reminders` 的 JSON 包含 `email`、`conditions`，首次持码建立时另带 `inviteCode`：

- 新成员使用有效且未绑定的码；可接受的邀请状态是 `available`，或由同一邮箱持有的有效 `reserved`。验证占位 30 分钟，邀请码从生成起有效 90 天。
- 已绑定成员使用 `Authorization: Bearer <管理令牌>` 新建，`email` 必须与令牌所属邮箱一致。此路径可直接启用新提醒；相同条件会返回原提醒，并保留原暂停状态。
- 绑定后的码不能再次作为公开新建凭据。成员管理权限由有效 Bearer 决定，不受邀请码 90 天期限影响；需要时通过管理邮件重新取得链接。

`conditions` 必须包含 `date`；可包含 `endDate`、`stationId`、`district`、`q`、`houseType`、`onlyOnShelf`、`minCount`，校验沿用查询规则。入住日在上海今天至未来 90 天内；连续入住最多 30 晚，且提醒必须指定一个 `stationId`。单日提醒可以关注全市。

单凭创建返回 `202` 不能判断邮件已送达或提醒已启用；已有 Bearer 的路径可查看返回的 `data.status`。首次持码创建还需验证邮件：`POST /api/reminders/verify` 使用 `{ "token": "<验证令牌>" }`，令牌有效 30 分钟；成功返回 `managementToken` 和自己的提醒列表。管理令牌有效 30 天，通过邮件 URL fragment 交给前端，再作为 Bearer 使用，不能写入日志或截图。

`POST /api/reminders/access` 使用 `{ "email": "you@example.com" }`；仅向具备资格的邮箱排管理邮件，所有邮箱收到相同 API 提示。`PATCH` 接受 `conditions`、`status: "active" | "paused"`，也兼容布尔值 `paused`。`DELETE` 删除记录并停止该提醒，返回 `status: "cancelled"`；删除全部提醒不会释放邀请成员身份。

每条启用提醒计划每 15 分钟检查。首次有新鲜的符合房源时提醒一次，持续有房不重复；只有完整、新鲜且明确无房的观测才重新准备下一次“有房”通知。失败、未知和过期数据不会触发无房重置。

## 错误与健康状态

错误体通常为 `{ "error": "说明", "code": "稳定错误码" }`；查询校验可能附带 `details.field`。常见状态包括：

| HTTP | 错误码示例 | 处理 |
| --- | --- | --- |
| `400` | `INVALID_INPUT` | 修正参数或 JSON |
| `401` | `INVALID_TOKEN` | 重新取得有效管理或验证链接 |
| `403` | `INVITATION_REQUIRED`、`ORIGIN_REJECTED` | 检查邀请授权或同源请求 |
| `409` | `REMINDER_LIMIT` | 删除不需要的提醒后再试 |
| `429` | `RATE_LIMITED` | 按 `Retry-After` 等待 |
| `503` | `SNAPSHOT_PENDING`、`SNAPSHOT_STALE`、`REMINDER_CAPACITY`、`REMINDERS_UNAVAILABLE` | 数据准备、容量或邮件配置暂不可用 |

`/api/health` 返回的 `mailConfigured`、`monitoringEnabled` 是配置状态，不证明官网采集、定时任务或邮件投递已成功；需结合快照时间、任务记录和实际收件分别验证。

官网访问仅使用公开列表与日历 GET，以及获授权的连续入住余房 POST；项目不调用官网登录、入住申请或数据修改接口。
