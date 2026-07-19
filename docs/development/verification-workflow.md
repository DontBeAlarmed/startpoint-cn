# 开发验证工作流

## 日常命令

- 日常开发优先运行 `npm run test:changed`，按未提交改动选择相关测试；需要稳定复测某个文件时，可直接运行 `node tools/test-workflow/run.cjs --files <path>`。
- 提交前运行 `npm run verify:full`，完成类型检查、全部服务端回归、仓库卫生检查和 CN 服务端构建验证。
- 只有 `admin/package-lock.json` 等后台 lockfile 发生变化时才运行 `npm run install:admin`。普通后端改动和仅后台源码改动不重复安装依赖。
- runtime seed、seed 扫描结果和 `confirmed_seeds` 等运行时数据不得提交。生成器或物理 seed 扫描也不进入普通回归测试。

本阶段不按 Node.js 20 与 22 分别设置阈值或维护两套成绩。基准使用本机当前默认 Node.js、已安装依赖和预热后的文件系统缓存；每个命令先预热一次，再正式运行三次并取中位数。`startedAt` 只用于记录测量时间，不得参与未来任何 `bundleId` 计算。

## 基准工具

默认检查模式：

```bash
npm run benchmark:workflow
```

默认检查模式中，中位数超过设计阈值会非零退出。采集现状而不因超阈值失败时使用：

```bash
node tools/test-workflow/benchmark.cjs --report-only --output /tmp/starpoint-cn-workflow-benchmark.json
```

`--report-only` 只豁免性能阈值；被测命令本身失败、超时或无法启动时仍非零退出。可用 `--only <name>` 单独测量 `test:quick`、`test:changed`、`test:integration`、`test:full` 或 `typecheck`。JSON 报告包含 commit、Node.js 版本、三次正式耗时、中位数、阈值、达标状态、测试计数和原始退出码。

## 当前实测

- 测量日期：2026-07-20
- 起点 commit：`0e70f866525658787fd6177589a9e849c689111b`
- 默认 Node.js：`v22.23.1`

| 命令 | 三次正式耗时（秒） | 中位数（秒） | 阈值（秒） | 当前状态 | 通过/失败/跳过 |
|---|---:|---:|---:|---|---:|
| `test:quick` | 9.538 / 6.723 / 9.202 | 9.202 | 5 | 未达指标 | 14 / 0 / 0 |
| `test:changed -- --files src/lib/gacha.ts` | 0.273 / 0.270 / 0.283 | 0.273 | 20 | 命令失败，不计为达标 | 0 / 0 / 0 |
| `test:integration` | 36.511 / 30.553 / 36.336 | 36.336 | 30 | 未达指标 | 17 / 0 / 1 |
| `test:full` | 41.073 / 42.981 / 39.645 | 41.073 | 60 | 达标 | 36 / 0 / 1 |
| `typecheck` | 29.854 / 22.399 / 20.592 | 22.399 | 30 | 达标 | 0 / 0 / 0 |

当前整体**未达设计指标**，不得据此宣称阶段 0 性能验收通过。最慢中位数是 `test:full` 的 41.073 秒，但它仍在 60 秒阈值内；按相对阈值看，`test:quick` 超出最多。`test:changed` 的固定基准调用被现有 package script 展开为同时传入 `--changed` 与 `--files`，runner 以原始退出码 2 拒绝冲突 selector，因此其短耗时只是快速失败，不是有效性能数据。该事实保留为当前工作流问题，未通过放宽阈值或改写结果掩盖。
