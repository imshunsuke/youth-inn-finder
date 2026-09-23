# 青年驿站房源查询 / Youth Inn Finder

查询[上海青年驿站一张图](https://qnyz.shyouth.net/TWYouthInnV2/static/onemap/index.html)未来几天的全市可用房源，按日历查看每天的可用房源数与有房驿站，并直达各驿站的官方详情与申请页面。

A zero-dependency Node.js web app + REST API for checking Shanghai Youth Inn (青年驿站) room availability, with a 21-day calendar view and per-station details linking to the official application pages.

> 数据来源为官方公开接口，本项目仅做只读查询，**不代提交申请、不绕过登录/验证码/审核**。能否申请成功以官方页面、个人资格和驿站审核为准。

## 功能

- 日历视图固定展示从今天到官网未来第 20 天（共 21 个日历日），每天显示全市可用房源总数和有房驿站数量；
- 点击某一天查看当天各驿站明细，可直达该驿站的官方详情和申请页面；
- 默认查询"可供个人申请房源"，可切换"全部房源"；可切换是否只统计上架驿站；
- 提供 REST API（`/api/available`、`/api/calendar`、`/api/nearest`），网页与未来的小程序共用同一套服务层；
- Node.js 运行时只使用内置模块，无第三方运行时依赖。

## 快速开始

要求 Node.js 18+。

```bash
cd youth-inn-finder
npm test
npm start
```

打开 <http://127.0.0.1:3000>。开发时可用 `npm run dev`（文件变更自动重启）。

## 网页使用

1. 页面固定展示从今天到官网未来第 20 天；
2. 默认查询"可供个人申请房源"，可切换"全部房源"；
3. 可切换"只统计上架驿站"；
4. 点击某一天查看当天各驿站明细。

网页默认覆盖所有区域，不提供区域筛选。今天和明天会标记为"暂未开放"（官方申请页的日期边界是最早今天后第 2 天、最晚今天后第 20 天），不会与真正的 0 间房源混淆；官方日历接口未返回的日期保留显示为 0，不能据此断言全市绝对没有房源。

## REST API

### 日历

```text
GET /api/calendar?startDate=2026-08-23&days=21&onlyOnShelf=true&houseType=0
```

| 参数 | 说明 |
| --- | --- |
| `startDate` | 可选，起始日期，网页默认使用当前日期 |
| `days` | 可选，1–31，默认 21 |
| `onlyOnShelf` | 可选，`true`/`1` 时只统计上架驿站 |
| `houseType` | 可选，`0`=可供个人申请房源（默认），`1`=全部房源 |

响应中的 `stations` 是站点级日历数据，每个驿站的 `availability` 含每天的 `availableCount` 与 `availabilityStatus`，前端据此在"可用驿站"卡片内绘制连续入住参考日历。

### 按日期查可用房源

```text
GET /api/available?date=2026-09-06&endDate=2026-09-10&lat=31.2304&lon=121.4737&limit=10
```

| 参数 | 说明 |
| --- | --- |
| `date` | 必填，入住日期 `YYYY-MM-DD` |
| `endDate` | 可选，离店日期 |
| `district` | 可选，例如 `浦东新区` |
| `onlyOnShelf` | 可选，`true`/`1` 时只返回上架驿站 |
| `houseType` | 可选，`0`=可供个人申请房源（默认），`1`=全部房源 |
| `minCount` | 可选，最少可用房源数，默认 1 |
| `lat`, `lon` | 可选，当前位置；必须同时提供 |
| `limit` | 可选，返回数量，默认 20 |

### 就近驿站

```text
GET /api/nearest?lat=31.2304&lon=121.4737&limit=10&onlyOnShelf=true
```

### 响应示例

```json
{
  "data": [
    {
      "id": "194",
      "name": "和光寓外滩店青年驿站",
      "district": "黄浦区",
      "address": "黄浦区中山东二路8弄3号2幢",
      "availableCount": 1,
      "distanceKm": 1.34
    }
  ],
  "meta": {"date": "2026-09-06", "endDate": "2026-09-10"}
}
```

## 数据来源与使用边界

服务端只读取网站前端实际使用的公开接口：

```text
GET  https://qnyz.shyouth.net/qnyzApi/hous/housList?userType=0&housType=<0 或 1>
GET  https://qnyz.shyouth.net/qnyzApi/hous/calendar?id=<驿站ID>
POST https://qnyz.shyouth.net/qnyzApi/into/idleHouseCnt
```

- 单日查询使用日历接口；填写 `endDate` 后使用申请页实际调用的区间查询接口；
- 只执行读取和可用性查询，不提交入住申请，不绕过登录、验证码或审核流程；
- 明细中的"申请入驻"链接把官方房源对象编码到官方 `houseDetails/houseDetails?passObj=...` 页面，直接打开对应驿站的官方详情；
- 请合理控制请求频率，仅供个人学习与查询使用。

## 小程序接入

业务逻辑集中在 `src/service.mjs`，上游接口封装在 `src/api.mjs`；网页消费 `/api/calendar`，小程序可复用 `/api/calendar`、`/api/available`、`/api/nearest`。部署给小程序使用时需配置 HTTPS、域名白名单、限流和缓存；本地 `127.0.0.1` 不能直接被手机小程序访问。

## 项目结构

```text
server.mjs            HTTP 服务与路由
src/api.mjs           上游公开接口封装
src/domain.mjs        纯业务规则（筛选、排序、日期校验）
src/service.mjs       查询编排（供网页与小程序共用）
public/               前端页面
test/                 Node.js 内置测试（npm test）
```

## 测试

```bash
npm test
```

测试全部使用注入的假数据源，不依赖网络。测试中的日期均为相对日期，不会随时间失效。

## 相关项目

- [Falgan678/youth-station](https://github.com/Falgan678/youth-station)：全国青年人才驿站聚合查询平台（含 AI 助手），覆盖城市更广；
- [chenmisss/shanghai-landing-kit](https://github.com/chenmisss/shanghai-landing-kit)：来上海落地包（公租房通勤地图、毕业生落户/求职指南）。

本项目专注上海青年驿站的**未来 21 天逐日可用房源**查询与日历展示，与上述项目不冲突，欢迎对比使用。

## License

本项目以 [Apache-2.0](./LICENSE) 协议开源（Copyright © 2026 Shunsuke）。欢迎使用、修改、商用与再分发（含专利授权），需保留版权与许可声明并标注修改；协议附完整免责声明。
