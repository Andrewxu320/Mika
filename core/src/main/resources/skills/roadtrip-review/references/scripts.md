# 这个技能带的脚本

一律经 `run_bundled_script` 跑:`source` 填 `skills/roadtrip-review`,`args` 里给行程目录(相对 `/workspace`,如 `trips/chuanxi`)。入口都在 `scripts/`,共用代码在 `lib/`,`templates/` 是页面模板。脚本从上游 lulu-road-trip-planner 原样取来(MIT,原文见 `LICENSE.lulu.md`),只加了两行头、并把共用代码的路径改到 `../lib/`。

| 脚本 | 做什么 | 什么时候跑 |
|---|---|---|
| `scripts/validate-trip.mjs` | 按 schema 和规则校验整个行程目录,输出结构化诊断;不通过时退出码非零 | 每次改完 `trip.json`、渲染之前 |
| `scripts/render-bundle.mjs` | 一次渲染全部产物:报告、地图、总览、清单与校验结果;校验不过就停下。成功后再回写 `trip.json`(`state` → `rendered`、`artifactRevision` → 当前 revision) | 交付之前 |
| `scripts/render-report.mjs` | 只生成路线审查与行程两个页面,并写出校验结果 | 只想先看报告、不画图时 |
| `scripts/render-map.mjs` | 只生成地图页(轨迹与风险点) | 单独重画地图时 |
| `scripts/render-overview.mjs` | 只生成总览页 | 单独重做总览时 |
| `scripts/diff-assessments.mjs` | 比较两次评估快照,列出变化 | 复查时对比上一版 |
| `scripts/fetch-amap-route.mjs` | 走高德 Web 服务取路段几何,写进 `routes/`;要联网和 Key。停靠点没有坐标时加 `--geocode` 先补坐标(逐条校验,拿不准就跳过) | 需要地图轨迹时 |

`fetch-amap-route.mjs` 是唯一要联网的,Key 经 `secretEnv` 给:`secretEnv=["AMAP_KEY=amap"]`。
