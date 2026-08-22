# 全服务端混合负载验收设计

状态：已通过自动验收，客户端人工验收待执行

日期：2026-08-22

## 背景

本项目的服务端重构源于真实部署中的容量问题：约 1000 份玩家存档、约 600 名在线玩家时，旧实现曾出现严重卡顿。各模块已经分别完成结构重构、专项性能门禁和自动回归；最终验收需要证明这些模块组合后仍能稳定运行，但不能把 600 个活跃身份误写成 600 个同步请求或 600 条同时建立的 TCP 连接。

本设计采用增强组合门禁。非多人业务在同一 SQLite 中精确观察 SQL 与事件循环；多人业务在真实 Host、Client 和 Hub 进程中观察协议、跨服存档与资源清理；房间存活期间额外执行普通 HTTP 请求，证明多人活动不会阻断同一服务进程的核心业务。首期不增加测试专用 IPC，不把不同风险边界强行塞进一套难以解释的测量模型。

## 总体架构

```text
FullServerAcceptance
  ├─ NonMultiFormalWorkload
  │    ├─ 1000 份隔离账号存档
  │    ├─ 600 个活跃身份
  │    ├─ 并发 10 / 25 / 50 / 100
  │    └─ auth / load / mission / single / shop / gacha / mail
  │
  ├─ MultiHubFormalWorkload
  │    ├─ Host A + Client B + Hub control + Hub TCP
  │    ├─ 120 个独立多人身份
  │    ├─ 60 个双人跨服房间
  │    └─ 房间并发 5 / 10 / 20
  │
  └─ CoexistenceSmoke
       └─ 房间与 TCP 存活期间执行 auth / load / mission HTTP
```

`FullServerAcceptance` 只组合报告和准入结果，不重新实现账号、数据库、HTTP 编码、房间或 TCP 协议。非多人子报告继续复用现有正式 runner；多人子报告复用真实多进程 harness 和现有协议帮助函数。

## 身份与并发语义

- 非多人正式负载准备 1000 份互相独立的账号存档，每个并发档选择 600 个活跃身份，各执行一个确定性入口请求。
- `10/25/50/100` 是同时在途请求上限，不表示 600 个请求同时开始。
- 多人身份占活跃身份的 20%，即 120 个独立身份，组成 60 个双人房间。
- 120 个多人身份是按 `600 × 20%` 确定规模的独立验收队列，不与非多人 runner 的 600 份身份或数据库复用。两层结果共同描述容量风险，但不宣称 600 个身份在同一时刻混合执行全部业务，也不把两层执行量相加解释为 720 人同时在线。
- 多人房间并发档为 `5/10/20`。每档均从干净的隔离运行数据启动并完成 60 个房间，不复用上一档房间、socket、active quest 或数据库写入。
- 60 个房间中 30 个由 Host A 所属玩家担任游戏房主，30 个由 Client B 所属玩家担任游戏房主。基础设施 Host 与游戏房主身份必须分开验证。
- 本设计不宣称生产环境固定有 20% 玩家处于多人房间；该比例是经用户确认的验收覆盖参数。

## 正式基线结果

2026-08-22 的三轮正式自动验收已通过。三轮均满足以下稳定规模和结构门禁：

| 子负载 | 稳定规模 | 结构结果 |
|---|---|---|
| 非多人 | 1000 份隔离存档、600 个活跃身份、并发 `10/25/50/100` | 每档 600/600 请求完成；错误、active quest 与清理资源均为 0 |
| 多人 | 120 个独立身份、60 个双人房间、并发 `5/10/20` | 每档 60/60 房间、120/120 身份完成；30 个 Host-owned + 30 个 Client-owned；错误、active quest 与清理资源均为 0 |
| HTTP 共存 | 每个存活房间批次固定执行 6 次请求 | auth、load、mission 在 Host 与 Client 各执行一次，全部完成且不改变房间权威状态 |

非多人三轮实测 SQL 结构上界如下。行为签名在四档并发和三轮之间保持稳定；`load` 与 `single-battle` 各保留三种预期状态签名，其他入口各保留一种：

| 入口 | reads 上界 | writes 上界 | 稳定签名数 |
|---|---:|---:|---:|
| auth | 8 | 3 | 1 |
| load | 50 | 9 | 3 |
| mission-progress | 14 | 1 | 1 |
| single-battle | 146 | 101 | 3 |
| shop | 44 | 5 | 1 |
| gacha | 82 | 9 | 1 |
| mail | 31 | 4 | 1 |

多人两种房主归属的稳定行为签名为：

- `sha256:0e4c3c3182af0f022c9b58b3a8f9ecb182782a15904ed1266a4e037d7c019cfe`
- `sha256:574691a3eb0659697ff8db0537a767d683d71862680527bd760a2db38521ed7c`

三轮各子报告最大 step p95 的中位数为：非多人 `6102.594 ms`，多人 `2883.015518 ms`。同机器且 formal profile 完全一致时，后续正式报告相对参考中位数的任一比值超过 `1.2` 即拒绝；机器或 profile 不同则只记录比值，不执行延迟硬门禁。结构门禁不因不可比较而放宽。

## 非多人负载

现有 `non_multi_mixed_workload` 保持职责不变：

- 固定虚拟服务器时间和 Content snapshot；
- 精确记录每请求 SQL reads/writes、延迟、事件循环延迟和行为签名；
- 覆盖登录、`/load`、任务进度、单人战斗结算、商店、抽卡和邮件；
- 对写入口执行事务故障注入，确认失败不留下库存、奖励或任务半状态；
- 每档结束后关闭 Fastify 与 SQLite，并删除临时运行目录。

Task 9 不为加入多人而改变该 runner 的数据库模型或已有机器准入语义。

## 真实多人负载

每个并发档启动两个游戏服务进程：

```text
Host A:
  游戏 HTTP + EmbeddedMultiCoordinator + Hub control + Hub TCP + SQLite A

Client B:
  游戏 HTTP + RoutedMultiCoordinator + SQLite B
```

所有端口均动态分配到 loopback，运行目录与 SQLite 互相隔离。测试通过真实 MsgPack HTTP 和空字符分帧 Typepacker TCP 驱动以下流程：

```text
注册
  -> create_room
  -> 双方 prepare
  -> 双方 TCP room handshake
  -> Enter / Mates
  -> Ready / StartBattle
  -> battle handshake / SceneReady / Heartbeat
  -> Finalize
  -> 双方分别 HTTP finish
  -> disband / socket cleanup
```

多人 runner 不直接修改数据库来伪造房间、active quest、结算完成或奖励结果。测试准备所需的账号和初始存档可以使用现有受测 signup/fixture 边界，但业务流程必须经过真实路由和 Coordinator。

## HTTP 共存烟测

每个多人并发档在至少一批房间已经完成 TCP Enter、但尚未 Finalize 时，对 Host A 和 Client B 的非参战身份执行确定性的 auth、`/load` 和任务查询请求。

共存烟测只验证：

- HTTP 请求完成且响应结构合法；
- 多人房间、TCP peer 和当前当局没有被普通 HTTP 请求破坏；
- 普通 HTTP 不因 Hub 活动进入错误的多人降级或房间清理路径。

子进程当前没有 SQL 与事件循环观测通道，因此共存烟测只记录错误、完成数和墙钟延迟。首期不为此增加测试专用 IPC；精确 SQL 和事件循环门禁继续由非多人正式 runner 与多人结构基线负责。

## 报告与准入

最终报告包含固定字段：

- 非多人正式 profile、四档 step 和 admission gate；
- 多人 profile、三档 room step、双向房主分布和行为签名；
- HTTP 共存请求分布与结果；
- 所有清理计数；
- 总门禁结论和有限失败原因。

准入要求：

1. 非多人正式 gate 全部通过，600 个活跃身份与并发档结构合法。
2. 每个多人档完成 60/60 房间和 120/120 玩家，HTTP、TCP、房间与结算错误均为 0。
3. 只有游戏房主扣除体力和门票；基础设施 Host 身份不得改变扣费归属。
4. 双方奖励、任务和关卡进度只写入所属 SQLite，且每个 finish 只结算一次。
5. 所有多人 active quest 已清理；重复 finish 不得重复发奖。
6. 多人行为签名跨并发档稳定；动态端口、房间号、viewer ID、时间和墙钟延迟不进入稳定签名。
7. 共存 HTTP 全部成功，并且不会改变仍在进行中的房间和 battle 身份。
8. 故障场景不得留下库存、奖励、任务或 active quest 半状态。
9. 每档结束后 peer、房间、端口、子进程、临时数据库和临时目录全部归零。

结构 SQL 上界继续引用现有快照，不在总报告中复制第二套上界。墙钟延迟只用于同机三轮观察；若与同一 runner 的检入参考相比中位数退化超过 20%，总门禁拒绝。跨机器数据不作为硬门槛。

## 运行方式与产物路径

默认命令只运行锁定的小规模 smoke：

```bash
npm run benchmark:full-server-acceptance
```

smoke 使用 7 份非多人存档、7 个活跃身份、并发档 2，以及 2 个多人身份、1 个 Host A 房主房间、并发档 1。它用于真实进程、协议、结算与清理回归，不产生正式容量基线，也不满足正式准入规模。

正式验收必须显式执行：

```bash
npm run benchmark:full-server-acceptance -- --formal
```

正式模式默认运行三轮。每轮使用 1000 份非多人存档、600 个活跃身份和并发档 `10/25/50/100`；多人部分使用 120 个独立身份组成 60 个双人房间，Host A 与 Client B 各担任 30 个游戏房主，并发档为 `5/10/20`。120 个多人身份是 600 个活跃身份的 20% 验收覆盖参数，不表示两层负载合计为 720 人同时在线。

完整总报告始终写入标准输出，子报告完整嵌入 `rounds[].nonMulti` 与 `rounds[].multi`，不会默认创建报告文件。需要留存时使用 `--output <report.json>`；相对路径从命令执行目录解析，父目录必须已经存在，目标必须是普通文件且不能是符号链接。写入文件与标准输出的 JSON 内容一致。

同机延迟门禁默认读取 `tools/perf/__snapshots__/full_server_acceptance_reference.json`。只有显式 `--formal`、恰好三轮且三轮结构门禁全部通过时，才允许使用 `--write-reference <reference.json>` 写出参考；`--output` 与 `--write-reference` 必须指向不同的物理文件。正式报告与同机器、同 profile 的参考比较，任一子负载 p95 中位数退化超过 20% 即拒绝；机器或 profile 不同则只记录比值，不作为硬门禁。正式参考已由上述三轮通过结果建立，日常 smoke 和 full/integration 测试不得重写该参考。

## 错误与清理

- 任一请求、socket、子进程或状态断言失败时，当前房间记录失败并进入统一清理；不能因为一个慢连接阻塞其他房间清理。
- 多进程 harness 必须在主错误之后继续尝试关闭全部 peer 和 runtime，并等待动态端口可重新绑定。
- 清理产生的附加错误使用 `AggregateError` 挂到主错误，不覆盖首个业务失败。
- 测试日志只保留有限场景编号、阶段和错误摘要，不输出令牌、完整身份、数据库绝对路径或原始协议正文。
- 测试运行前仍需检查支持端口无同名残留服务；测试结束后再次确认资源归零。

## 文件边界

新增的多人和总门禁工具保持小文件职责：

- `tools/perf/multi_hub_load_workload.cjs`：运行三档真实多人负载并负责总清理；
- `tools/perf/multi_hub_load_scenarios.cjs`：单房协议流程与 HTTP 共存场景；
- `tools/perf/multi_hub_load_metrics.cjs`：报告校验、行为签名和 admission；
- `tools/perf/multi_hub_load_workload.test.cjs`：runner、清理和小 profile 集成测试；
- `tools/perf/full_server_acceptance.cjs`：组合非多人和多人子报告；
- `tools/perf/full_server_acceptance.test.cjs`：总报告结构与失败传播。

可以提取现有 `tests/multi-hub-process.test.js` 中稳定的战斗阶段帮助函数，但不得把测试流程复制成多个互相漂移的大文件。生产 `src/` 不因 Task 9 增加测试开关、IPC、路由或指标端点。

## 最终验证

`npm run test:full` 展开 `integration:multi-hub` 时只执行 smoke 和真实小规模回归，不附加 `--formal`。正式规模只允许通过上述显式 benchmark 命令或直接执行 `node tools/perf/full_server_acceptance.cjs --formal` 触发。

工作流接入完成后继续执行：

- 多人专项、快照、结算、Hub 和故障注入回归；
- `npm run test:full`；
- `npm run typecheck`；
- `npm run docs:check`；
- `npm run build:server`；
- `npm run hygiene`。

CN 客户端、Android 壳和真实多设备人工验收继续延后到全部自动验证结束后，不在 Task 9 中伪装为已完成。

## 明确不实现

- 不增加测试专用生产 IPC、遥测路由或管理接口；
- 不模拟 600 条同时 TCP 连接；
- 不引入外置 Coordinator、消息队列、分布式数据库或进程间事务；
- 不实现真实随机招募、救援通知、公开房间列表或社交功能；
- 不借性能验收修改游戏协议、奖励语义或客户端资源。
