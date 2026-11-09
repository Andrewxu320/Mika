# Mika 宿主适配器

Mika 的工具集按任务装配、静态已知:不用探测"有没有这个工具",要判断的是"这次数据到底取没取到"。判定口径仍以 `references/capability-policy.md` 为准,本文件只写对应关系。

| 语义能力 | Mika 侧 | 怎么判 |
|---|---|---|
| `search_web` | `web_navigate` + `web_read_page` / `web_observe` | 读到带网址的正文即 `available`;被登录墙、风控挡住记 `limited`,失败信息写清是哪一种 |
| `fetch_route` | `run_bundled_script` 跑 `fetch-amap-route.mjs`,Key 经 `secretEnv` 给 | 几何写进 `routes/` 才记 `available`;没 Key、没联网、401 → `unavailable` 或 `limited`,绝不画直线 |
| `fetch_weather` | `web_read_page` 读预报页 | 城市级 → `limited`;读不到 → `unknown` |
| `fetch_traffic_events` | 网页、微博、地方交警,以及 App 里的实地帖 | 只读到零散消息 → `limited`;没搜到不等于没封路 |
| `fetch_elevation` | 无 | `unavailable`;不得由端点坐标反推剖面 |
| `read_user_file` | 聊天附件落在 `/workspace/inbox/`,用 `read_file` | 读得到 → `available`;不在 → 把失败信息写进 `capabilities` |
| `write_artifact` | `write_file` | `available`;导出另受下面那条闸门约束 |
| `open_navigation` | 没有真正的交接 | `limited`:只能给出深链让用户自己点 |

## 导出闸门

行程目录(同目录有 `trip.json`)里的任何文件,`share_file` 都要求同目录 `validation.json` 的 `valid` 为 true;有 `manifest.json` 时还要求它的 `tripRevision` 与 `trip.json` 的 `revision` 一致。这是代码里的硬门,不是提醒:被拒时按错误码 `trip_not_validated`、`trip_not_valid`、`trip_validation_unreadable`、`trip_artifacts_stale` 修,不要换个文件名绕过去。

## 环境与节奏

- 沙箱默认不联网;需要 `fetch-amap-route.mjs` 时,要用户在设置 › 高级里打开「允许脚本联网」,否则工具会直接拒绝并给出提示。
- 加密存的密钥只经 `secretEnv` 交给脚本那次进程;不要写进 `trip.json`、报告、命令或临时文件。
- 网页默认桌面版;路况类站点在手机版上信息更全时用 `web_site_mode` 切换。
- App 里的路况是自绘界面,读屏可能缺字:用 `phone_observe` 看图,或 `phone_collect` 逐屏读。
