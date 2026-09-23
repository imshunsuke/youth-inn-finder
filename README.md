# 青年驿站房源查询 / Youth Inn Finder

查询[上海青年驿站一张图](https://qnyz.shyouth.net/TWYouthInnV2/static/onemap/index.html)的全市可用房源：21 天日历看每天可用房源数与有房驿站，点开直达各驿站官方详情与申请页面。零依赖 Node.js（18+）网页 + REST API。

> 数据来源为官方公开接口，本项目仅做只读查询，**不代提交申请、不绕过登录/验证码/审核**。

## 功能

- 21 天日历（今天起 21 个日历日）：每天全市可用房源数与有房驿站数，点击查看当天各驿站明细、直达官方详情/申请页；
- 可切换"可供个人申请房源 / 全部房源"和"只统计上架驿站"；
- REST API：`/api/calendar`、`/api/available`、`/api/nearest`，网页与小程序共用同一服务层；
- 运行时只用 Node 内置模块，无第三方依赖。

今天和明天标记为"暂未开放"（官方申请页最早可选今天后第 2 天），不会与 0 间房源混淆；官方日历接口未返回的日期显示为 0，不代表全市绝对无房。

## 快速开始

```bash
npm test    # 10 个测试，假数据源，不需要网络
npm start   # → http://127.0.0.1:3000
```

开发用 `npm run dev`（文件变更自动重启）。

## REST API

### 日历 `GET /api/calendar`

`?startDate=2026-08-23&days=21&onlyOnShelf=true&houseType=0`

| 参数 | 说明 |
| --- | --- |
| `startDate` | 起始日期，默认今天 |
| `days` | 1–31，默认 21 |
| `onlyOnShelf` | `true`/`1` 只统计上架驿站 |
| `houseType` | `0` 可供个人申请（默认），`1` 全部房源 |

响应含 `stations` 站点级日历（每天 `availableCount` 与 `availabilityStatus`）。

### 按日期查可用房源 `GET /api/available`

`?date=2026-09-06&endDate=2026-09-10&lat=31.2304&lon=121.4737&limit=10`

| 参数 | 说明 |
| --- | --- |
| `date` | **必填**，入住日期 `YYYY-MM-DD` |
| `endDate` | 离店日期 |
| `district` | 如 `浦东新区` |
| `onlyOnShelf` / `houseType` | 同上 |
| `minCount` | 最少可用房源数，默认 1 |
| `lat` + `lon` | 当前位置，必须同时提供 |
| `limit` | 返回数量，默认 20 |

### 就近驿站 `GET /api/nearest`

`?lat=31.2304&lon=121.4737&limit=10&onlyOnShelf=true`

## 数据来源与使用边界

只读取官网前端实际使用的公开接口：

```text
GET  https://qnyz.shyouth.net/qnyzApi/hous/housList?userType=0&housType=<0 或 1>
GET  https://qnyz.shyouth.net/qnyzApi/hous/calendar?id=<驿站ID>
POST https://qnyz.shyouth.net/qnyzApi/into/idleHouseCnt
```

不提交入住申请、不绕过登录/验证码/审核；"申请入驻"链接直达官方 `houseDetails` 页面。请控制请求频率，仅供个人学习与查询。

## License

[Apache-2.0](./LICENSE) © 2026 Shunsuke。
