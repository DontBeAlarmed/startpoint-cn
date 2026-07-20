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
- 完整基准起点 commit：`0e70f866525658787fd6177589a9e849c689111b`
- `test:changed` 修正复测基线 commit：`587e9785747e9c224fb3621a74c8fb3b9c1cedc1`
- Node.js：当前默认版本（不区分具体版本）

| 命令 | 三次正式耗时（秒） | 中位数（秒） | 阈值（秒） | 当前状态 | 通过/失败/跳过 |
|---|---:|---:|---:|---|---:|
| `test:quick` | 9.538 / 6.723 / 9.202 | 9.202 | 5 | 未达指标 | 14 / 0 / 0 |
| `node tools/test-workflow/run.cjs --files src/lib/gacha.ts` | 5.158 / 4.270 / 3.415 | 4.270 | 20 | 达标 | 4 / 0 / 0 |
| `test:integration` | 36.511 / 30.553 / 36.336 | 36.336 | 30 | 未达指标 | 17 / 0 / 1 |
| `test:full` | 41.073 / 42.981 / 39.645 | 41.073 | 60 | 达标 | 36 / 0 / 1 |
| `typecheck` | 29.854 / 22.399 / 20.592 | 22.399 | 30 | 达标 | 0 / 0 / 0 |

当前整体**未达设计指标**，不得据此宣称阶段 0 性能验收通过。最慢中位数是 `test:full` 的 41.073 秒，但它仍在 60 秒阈值内；按相对阈值看，`test:quick` 超出最多。`test:changed` 修正后直接调用 runner，三次原始退出码均为 0，4 个相关测试文件全部通过，中位数 4.270 秒，已在 20 秒阈值内。现有未达项仍是 `test:quick` 和 `test:integration`，未通过放宽阈值或改写结果掩盖。

## 第二轮分层优化实测

- 测量日期：2026-07-20
- 测量时 HEAD：`4395dd97e5aa66db0b325097103e880c3e7f5396`（包含本任务尚未提交的分组工作树改动）
- Node.js：当前默认版本（不区分具体版本）

| 命令 | 三次正式耗时（秒） | 中位数（秒） | 阈值（秒） | 当前状态 | 通过/失败/跳过 |
|---|---:|---:|---:|---|---:|
| `test:quick` | 2.744 / 2.845 / 3.697 | 2.845 | 5 | 达标 | 13 / 0 / 0 |
| `test:integration` | 29.836 / 27.729 / 28.186 | 28.186 | 30 | 达标 | 18 / 0 / 1 |

`quest_abort_route.test.cjs` 会加载并转译完整路由依赖，不再计入 quick，而是归入 `integration:compiled`。逐项审查该组后确认：纯函数测试不访问数据库；`character_awake_refresh.test.cjs` 和 `mission_completion.test.cjs` 在加载数据库模块前分别创建唯一的临时数据库目录；`quest_abort_route.test.cjs` 预先替换数据库模块并通过 Fastify `inject()` 测试，不绑定真实端口。该组因此改为最多 4 路并行。需要真实数据库语义的 `integration:database` 与预留的 `integration:cdn` 继续串行，所有 quick 组继续并行。

changed 选择器将 `src/lib/gacha-draw.ts` 精确映射到 `quick:gacha`；`src/routes/api/singleBattleQuest.ts` 同时选择 `integration:compiled` 和 `integration:database`，未知文件仍升级为 `full`。单次完整回归为 36 通过、0 失败、1 跳过，总耗时 29.42 秒。分层单次回归前后，真实 `.database`、`assets/confirmed_seeds.json` 和 `out/` 的内容摘要均未变化。

## 阶段 0 历史中间验收（已替代）

- 测量日期：2026-07-20
- 验收 commit：`2c84232d54f3c6260e1aaae5874ee5d46f9453bd`
- Node.js：当前默认版本（不区分具体版本）
- 工作树：`dirty=false`，tracked changes 0，untracked files 0
- `statusSha256`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- 原始报告：`/tmp/starpoint-cn-stage0-final.json`（本机临时文件，不进入仓库）

| 命令 | 三次正式耗时（秒） | 中位数（秒） | 阈值（秒） | 当前状态 | 通过/失败/跳过 |
|---|---:|---:|---:|---|---:|
| `test:quick` | 2.672 / 2.703 / 3.589 | 2.703 | 5 | 达标 | 13 / 0 / 0 |
| `test:changed` | 0.896 / 0.926 / 0.889 | 0.896 | 20 | 达标 | 4 / 0 / 0 |
| `test:integration` | 28.093 / 26.057 / 27.052 | 27.052 | 30 | 达标 | 20 / 0 / 1 |
| `test:full` | 32.545 / 27.793 / 29.041 | 29.041 | 60 | 达标 | 38 / 0 / 1 |
| `typecheck` | 20.328 / 19.613 / 17.921 | 19.613 | 30 | 达标 | 0 / 0 / 0 |

本次验收由非 `report-only` 的完整 benchmark 在 A 提交后的干净工作树上执行，五项预热后各运行三次，所有正式运行原始退出码均为 0。`score_attack_event.test.cjs` 与 `treasure_key_entry.test.cjs` 经副作用审查后从 generator 迁入并行的 `integration:compiled`：两者只读 CDN 参考数据、使用内存依赖，不访问真实数据库、不绑定端口，也不依赖跨进程共享状态。full 因此新增这两个运行时回归，由上一轮 36 项增加到 38 项；generator 仅保留真正的数据生成器验证。

changed 选择器对 `src/routes/api/singleBattleQuest.ts` 同时选择 `quick:quest`、`integration:compiled` 和 `integration:database`。测试清单契约会枚举至少 42 个测试文件，要求每个测试只属于一个叶组，并要求 full 精确覆盖全部非 generator 运行时回归。benchmark 报告只公开工作树是否脏、原始 porcelain 状态字节的 SHA-256 和变更数量，不包含状态文本、文件路径或 diff 内容。

上述 `2c84232` 结果后来被代码审查判定为中间结果：当时 representative changed 样本过轻，且两个测试文件仍混合了外部数据一致性校验和运行时行为。本节仅保留为优化过程记录，不再作为阶段 0 完成依据。

## 阶段 0 最终干净树验收（有效）

- 测量日期：2026-07-20
- 验收 commit：`8618af1e0dbbe307bc4ac19ec1c3849ab063243f`
- Node.js：当前默认版本（不区分具体版本）
- 工作树：`dirty=false`，tracked changes 0，untracked files 0
- `statusSha256`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- 原始报告：`/tmp/starpoint-cn-stage0-final-8618af1.json`（本机临时文件，不进入仓库）

| 命令 | 三次正式耗时（秒） | 中位数（秒） | 阈值（秒） | 当前状态 | 通过/失败/跳过 |
|---|---:|---:|---:|---|---:|
| `test:quick` | 3.507 / 3.677 / 4.288 | 3.677 | 5 | 达标 | 13 / 0 / 0 |
| `test:changed`（`singleBattleQuest.ts`） | 3.288 / 6.042 / 3.636 | 3.636 | 20 | 达标 | 7 / 0 / 0 |
| `test:integration` | 12.171 / 15.245 / 16.889 | 15.245 | 30 | 达标 | 20 / 0 / 1 |
| `test:full` | 18.412 / 19.204 / 16.672 | 18.412 | 60 | 达标 | 38 / 0 / 1 |
| `typecheck` | 24.547 / 26.265 / 23.711 | 24.547 | 30 | 达标 | 0 / 0 / 0 |

本次使用非 `report-only` 完整 benchmark；所有预热和正式运行命令均正常结束，三次正式运行的原始退出码全部为 0。`test:changed` 使用 `src/routes/api/singleBattleQuest.ts` 作为代表样本，运行路由契约、Fastify 行为和精确领域数据库测试，不再用轻量 gacha 文件代替真实 changed 工作流。

`score_attack_event.test.cjs` 与 `treasure_key_entry.test.cjs` 只保留自包含的内存运行时行为；orderedmap、转换器和生成结果一致性检查位于对应 `*_data.test.cjs` generator。full 覆盖所有非 generator 运行时回归，generator 不再承担运行时接线契约。

并行测试上限为 8，仅应用于已确认使用独立进程、内存状态或唯一临时数据库的测试；`integration:database` 和空的 `integration:cdn` 仍保持串行。基础设施异常会停止领取新任务，等待已启动 worker 收敛后再返回错误；普通测试失败仍完整汇总。
