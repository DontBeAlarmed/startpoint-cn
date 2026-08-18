# 任务引擎演进架构

> 状态：阶段 1～5 已实施，阶段 6 的第 13～15 项已实施；Category 1～10（包含 Awake 9）已接入 Session，结构性能基线与自动准入已固化。Task 33.6 已完成最终审查；全量回归 398 个测试文件全部通过。

## 目标

当前任务结算已经支持分类计算、定向候选、角色觉醒即时刷新和完整事务回滚，但主数据查询、事实读取和任务页响应仍存在重复工作。下一阶段在不改变客户端协议、任务条件、奖励语义和数据库结构的前提下完成以下目标：

1. 任务定义、分类、pattern 和奖励 stage 按当前 Content snapshot 建立 O(1) 索引。
2. 每条可计算任务明确声明所需事实，未知条件继续 fail closed。
3. 同一次任务求值阶段内，同一种事实最多加载一次。
4. 结算与响应复用同一份求值结果。
5. 任务奖励改变角色、装备、物品或玩家状态时，只重新计算受影响的任务，并保持同一次响应即时刷新。
6. 保留当前外层事务和失败回滚边界。

本阶段覆盖普通任务 Category 1 至 10（包含称号和 Pass）以及角色觉醒 Category 9。Active Mission 继续使用现有独立事实与结算体系，不并入本次重构。

## 生产负载背景

本次重构源于真实部署中的容量问题：当时服务器约有 1000 份玩家存档，在线玩家约 600 人，部署后出现严重卡顿。任务结算嵌在任务进度、单人战斗、多人战斗和角色羁绊等高频路径中；单次请求的重复查库和全量扫描会被在线规模放大。

因此，本重构不仅要求代码职责清晰，还必须提供以下可复核证据：

- 单次结算的 SQL、loader、候选和 compute 次数；
- 首次与重复调用的写入、奖励和完整响应等价；
- 任务入口在分层并发下的吞吐、P50/P95、事件循环延迟和错误率；
- 整体优化结束后的登录、load、战斗、商店、抽卡、邮件和日志混合负载；
- 联机与 Hub 在双服测试环境建立后的独立及混合负载。

600 人在线不等于 600 个任务结算请求在同一时刻执行。直接制造 600 个同步结算只能作为极端压力上限，不能冒充真实流量模型。

## 当前问题

当前标准结算链路为：

```text
scope -> Catalog 候选与开放时间过滤 -> PreparedMissionSettlement
      -> MissionEvaluationSession -> Computer.buildContextFromSession
      -> EvaluationResult -> 专用写入器 -> 响应合并
```

重构前的基线场景一次会扫描 3557 个候选，实际计算 177 条任务。不同 Computer 各自构造完整上下文，无法共享相同事实。阶段 1～5 已让 Category 1～8、10 在同一求值阶段共享 Session facts，阶段 6 的第 13 项又接入 Awake 9；候选准备、纯计算、进度写入和奖励发放现已拆分，第 14 项已固化结构性能基线与自动准入。

Pass Category 7/8 的迁移保留了必要的前置写入：Category 7 在缺少 `passWeek` 时创建周期快照，Category 8 通过 `ensurePlayerPassCardLoginProgressSync` 初始化登录基线；这些写入均在只读 Session 建立前完成。

`/mission/get_mission_progress` 还存在两个求值阶段：

1. 自动结算开放任务并发放奖励；
2. 重新构造上下文和任务进度，生成任务页响应。

第二阶段不能直接删除。任务奖励可能新增角色、装备或物品，当前行为会让相关进度在同一次任务页响应中立即更新，但不会在该请求内再次发奖。目标架构必须保留这一显示语义。

此外，`patterns.ts` 当前在模块加载时建立普通对象索引。CN 启动顺序允许任务模块先于 Runtime Content snapshot 初始化，因此 bundled 表与 runtime 表不一致时，索引可能在进程启动后保持陈旧。

## 设计边界

### 包含

- snapshot-scoped `MissionCatalog`；
- mission 到事实需求的分类；
- 事实到候选任务的反向索引；
- 当前事务内、单次求值阶段生命周期的 `MissionEvaluationSession`；
- Standard Computer 与 Awake Computer 的事实复用；
- 结算结果与任务页响应复用；
- 奖励副作用驱动的局部二次求值；
- Degree、Awake、`get_progress` 和战斗结算的结构性能证据。

### 不包含

- Active Mission 统一引擎；
- 跨请求或跨事务玩家缓存；
- 数据库 schema 迁移或事实物化表；
- 客户端协议字段调整；
- 任务规则、开放时间或奖励内容调整；
- CDN 热切换。当前生产 snapshot 仍为进程级固定内容。

## 组件

### MissionCatalog

`MissionCatalog` 是当前 Content repository 的只读任务索引，至少提供：

- `(category, missionId) -> definition`；
- `category -> missionIds`；
- `pattern -> definitions`；
- `(category, missionId) -> reward stages`；
- `(category, missionId, evaluationTime, eventId) -> enabled`；
- Awake 的 `characterId -> missionIds`。

Catalog 按 Content repository 或其底层表对象建立 `WeakMap` 缓存。初始化前 bundled repository 与初始化后 Runtime Content repository 必须得到不同实例，禁止模块级普通对象永久固定第一次读取结果。

无定义、重复定义、非法 mission ID 或无法解析的 stage 继续 fail closed。Catalog 只改变查找方式，不放宽任务可达性。

### FactRequirementRegistry

`FactRequirementRegistry` 把任务定义转换为一组事实键，并建立反向索引：

```text
mission -> FactKey[]
FactKey -> mission[]
```

首版事实键按领域和查询参数区分，至少包含：

- `player`；
- `characters`；
- `characterManaNodes`；
- `equipment`；
- `items` 与 `collectedItems`；
- `questProgress(sectionSet)`；
- `categoryMissionProgress(category)`；
- `missionBattleCounters`；
- `degreeBattleStats`；
- `periodicSnapshot(kind)`；
- `passState(eventId)`；
- `awakeEligibility`。

带参数的事实键必须规范化排序后再作为缓存键。例如 `[21, 7]` 与 `[7, 21]` 代表同一个关卡 section 集合。多个任务需要可合并 section 时，求值计划在加载前合并成一次批量查询。

已知仅依赖持久化进度的任务可以声明空事实集合。无法权威分类的任务不读取全量事实，继续返回已有持久化进度。

### MissionEvaluationSession

`MissionEvaluationSession` 由事务编排层在一次任务求值阶段开始时创建，包含：

- `playerId`；
- 固定的 `evaluationTime`；
- 当前 `MissionCatalog`；
- 本阶段的候选与事实需求；
- 按 `FactKey` 记忆化的 loader 结果；
- 可选的结构观察器，用于统计 loader、候选和 compute 次数。

Session 不跨事务、请求或求值阶段复用。任何可能改变已加载事实的写入发生后，当前 Session 即结束；后续求值必须创建新 Session。首版不实现细粒度缓存删除，以“阶段结束后重建”保证简单和正确。

Computer 不再自行决定如何重复查库，而是从 Session 获取已声明事实。`compute()` 继续保持纯函数，不允许通过 getter 或惰性对象在计算阶段执行数据库查询。

### MissionEvaluationResult

一次求值返回不可变结果，至少记录：

- 实际候选 mission ID；
- 每条任务的持久化进度、计算进度和最终进度；
- 当前完成 stage；
- 本次读取的 FactKey；
- 每条任务的事实依赖。

结算层消费该结果写入进度、领取 stage 并发放奖励；响应层消费同一结果生成 `mission_progress_list`。同一阶段内不得再次调用 Computer 计算相同任务。

## 阶段 4 已确认设计

采用三阶段流水线，外部继续只暴露 `settleMissionCategories`：

```text
settleMissionCategories（单个数据库事务）
  -> prepareMissionSettlement
  -> evaluateMissionCandidates
  -> settleMissionEvaluation
  -> 兼容的 MissionSettlementResult
```

### prepare

`prepareMissionSettlement` 负责所有允许写入的前置动作：

1. 合并 scope，过滤非法和未开放任务；
2. 为 Category 7 按 event 去重，缺失时创建一次 `passWeek` 快照；
3. 为 Category 8 按 event 去重，初始化一次登录基线；
4. 返回只读 `PreparedMissionSettlement`，包含固定 evaluation time、enabled scopes、候选引用和 Pass 前置结果。

前置动作必须幂等。重复调用不得重置已有快照或登录基线。

### evaluate

`evaluateMissionCandidates` 在 prepare 后创建一个 `MissionEvaluationSession`。Fact loader 全部只读；Computer 只读取已声明事实；同一规范化 FactKey 最多加载一次。函数不写数据库、不发奖励，返回不可变 `MissionEvaluationResult`。

结果至少包含只读玩家快照、每条候选的持久化进度、计算进度、最终进度和已领取 stage，以及 loader、候选和 compute 的结构观察数据。

### settle

`settleMissionEvaluation` 只消费 `MissionEvaluationResult`：

1. 写入真正变化的任务进度；
2. 写入首次完成的 stage；
3. 发放奖励并合并客户端响应；
4. 保持重复调用不重复写入和发奖。

prepare、evaluate、settle 继续位于同一个数据库事务。任何阶段失败，Pass 前置初始化、任务进度、stage 和奖励必须一起回滚。

### 方案升级边界

首选三阶段流水线，不提前引入“每个 Category 一个 handler”的框架。只有在完成相对基线和混合负载 profile 后，剩余瓶颈仍明确位于任务类别调度或类别上下文，且无法在三阶段边界内解决时，才重新评估按类别处理器拆分。全服务仍卡顿本身不能证明该升级有价值。

## 奖励失效与局部二次求值

奖励层在发放时返回实际改变的事实键，而不是只返回客户端响应字段。首版使用保守映射：

| 奖励或写入 | 失效事实 |
|---|---|
| 星导石、Mana、经验池、称号 | `player` |
| 道具 | `items`、`collectedItems` |
| 装备 | `equipment` |
| 角色 | `characters`、`items`、`collectedItems` |
| Pass 点数 | 对应 `passState(eventId)` |
| 觉醒解锁或玛纳板变化 | `characters`、`characterManaNodes`、`awakeEligibility` |

映射宁可多标记相关领域，也不能漏掉可能变化的事实。只有数据库实际发生变化时才返回失效键；重复领取、库存未变化或空奖励不得制造虚假失效。

`get_progress` 使用以下流程：

```text
创建阶段 A Session
  -> 计算请求分类
  -> 写入进度、领取 stage、发放奖励
  -> 收集实际失效 FactKey
  -> 未受影响任务直接复用阶段 A 结果
  -> 若存在受影响任务，创建阶段 B Session
  -> 为反向索引命中的请求内任务重新加载完整事实依赖并计算
  -> 合并为 mission_progress_list
  -> 阶段 B 只刷新响应，不再次发奖
```

这样保留奖励副作用后的即时显示，又避免所有任务重复构造上下文。阶段 B 只能计算本次请求中已开放、已通过 event/character 过滤的任务，不能借反向索引扩大响应范围。

## 角色觉醒

Awake 保留独立 eligibility、角色候选和奖励解锁语义，但接入相同的 Catalog、Session 和 EvaluationResult：

- 指定角色页面只建立该角色任务候选；
- 战斗结算只建立本场 main/Sub 涉及角色候选；
- all-complete 与玛纳板觉醒解锁仍在同一外层事务完成；
- Awake 奖励造成的角色、物品或装备变化纳入失效键；
- Active Mission 不因 Awake 接入而改变所有权。

## 事务与错误语义

1. 战斗事实、角色经验和其他业务写入必须先完成，再创建读取这些事实的求值 Session。
2. 进度写入、stage 领取、奖励发放、Awake 解锁与响应求值继续位于现有外层事务中。
3. loader、分类、计算、奖励或响应求值任一步失败，整个请求回滚。
4. 未知任务、未知条件、无效 event scope 和缺失权威定义继续 fail closed。
5. 空候选在创建 Session 前直接返回，保持零数据库访问。
6. 不把网络请求、Content 同步或其他非数据库操作加入任务事务。

## 迁移顺序

### 阶段 1：MissionCatalog

状态：已完成。

- 建立 snapshot-scoped definition、category、pattern、stage 和 Awake 角色索引；
- 将 `master-data.ts`、`stages.ts` 和 `patterns.ts` 切换到 Catalog；
- 保持现有导出函数作为兼容外壳；
- 验证 bundled 到 Runtime Content 初始化切换不会复用旧索引。

### 阶段 2：事实需求契约

状态：已完成。

- 定义 `FactKey`、规范化规则和 loader 注册表；
- 把现有 Degree 分类作为首个接入模块；
- 为 Regular、Event、Pass 和 Awake 建立需求映射；
- 对所有可计算任务检查“有且只有一个权威需求描述”，描述可以包含多个事实键；unsupported 集合保持不变。

### 阶段 3：阶段内 FactStore

状态：Category 1～8、10 已于本阶段完成；Awake 9 已于阶段 6 的第 13 项接入。

- 引入 `MissionEvaluationSession`；
- 先迁移重复读取最多的 player、quest progress、battle counters 和 periodic snapshot；
- Computer 接口改为接收 Session，不改变 `compute()`；
- 每迁移一个 Computer，保留 full/scoped 结果等价测试。

### 阶段 4：求值结果与标准结算

状态：已实施（方案 B）。

- 拆分 prepare、evaluate、settle；
- 让 settlement 内部复用不可变 EvaluationResult；奖励失效键和阶段 B 重算由阶段 5 接入任务页；
- 保持现有 `MissionSettlementResult` 响应兼容层；
- 验证重复调用不会重复发奖；
- Category 7/8 在 prepare 中完成幂等 Pass 前置写入，在 evaluate 中通过只读 Session facts 求值；
- Category 9 Awake 已在阶段 6 接入相同的 Catalog、Session 与 EvaluationResult；未扩展阶段 B 语义。

### 阶段 5：任务页响应

状态：已实施。

- `/mission/get_mission_progress` 复用阶段 A 的 `PreparedMissionSettlement` 和 `MissionEvaluationResult`；
- 奖励层在实际写入成功后返回规范化、不可变、批内去重的 `FactKey`；玩家事实在 `persistPlayer()` 成功后才标记；
- 只对奖励失效键反向索引命中的、且已经属于本次请求阶段 A 候选的任务执行阶段 B；
- 阶段 B 创建新只读 Session，只求值并覆盖任务页进度/阶段，不写进度、不领取 stage、不发奖励、不初始化 Pass 前置；
- 无失效奖励或无受影响任务时不创建阶段 B；
- 合并阶段 A/阶段 B 后保持请求顺序、任务响应字段、mail 和 Awake 响应字段兼容；
- 阶段 A 写入、奖励、阶段 B 求值和响应生成继续位于同一外层事务，任一步失败整体回滚。

### 阶段 6：Awake 与性能收尾

状态：第 13～15 项已实施；Task 33.6 已完成最终全量回归与独立审查。

- Awake 候选已接入 snapshot-scoped Catalog；指定角色页和战斗 main/Sub 只建立请求范围内候选，并合并本场 direct mission IDs；
- Category 9 已通过只读 Session 声明并加载角色、玩家、任务履历、角色 clear、同队 clear 和 scoped persisted mission facts；all-complete 显式声明三个子任务及其 facts；
- AwakeComputer 已使用 Session context，Category 9 persisted progress/stages 按候选及依赖 ID 单次批量读取，EvaluationResult 不再依赖 legacy `categoryMissionStates`；
- Awake 专用写入器只消费 EvaluationResult，写入 progress/stage、普通奖励和 mana board awake unlock，保留 eligibility、幂等与原响应结构；
- 单人、多人 finish 在本场事实和角色经验写入后调用共享 Awake settlement 边界，同次响应可见奖励和 unlock，注入失败时由原外层事务完整回滚；
- `/mission/get_mission_progress` 的 Category 9 指定角色页已复用 Catalog、Session 和 EvaluationResult，保持请求顺序、mail 与响应字段；不扩展阶段 B；
- 第 14 项已用确定性 focused snapshot 固化全部场景的行为 payload/hash 与结构上限：Awake 指定角色页为 `11/0/7`，single finish 为 `45/80/425`，multi finish 为 `46/91/425`（依次为 SQL reads/writes/mission computes）；
- 固定时间 `2024-08-14T12:00:00.000Z` 的单请求 no-invalidation `get_progress` 为 `14/4/107`；
- 固定时间 `2025-01-01T12:00:00.000Z` 的 focused snapshot no-invalidation `get_progress` 为 `14/4/110`；
- 分层 600 状态负载按已检入 summary/reference 的 `get_progress` entry structural max 为 `25/4/214`（每个 entry 的最大 SQL reads/writes/mission computes）；single/multi 仍使用 `mission-finish-boundary` adapter，不代表完整 battle HTTP；
- focused 自动准入要求场景集合完全一致、行为 payload/hash 完全一致、三项结构指标均为非负安全整数且不高于已检入 snapshot；允许后续优化下降，延迟不作为跨机器硬门槛；
- 普通 `benchmark:mission-engine-focused` 只读 snapshot，只有显式确定性 `--write` 才能在行为准入通过后更新结构值；Degree 与 Event 的专项等价/不增断言继续保留；
- Task 33.4 已为登录、load、任务进度、单人结算、商店、抽卡和邮件混合旅程增加 SQL 统计及四类事务后段故障注入；每个写入口均在完整玩家 owner 表和内存 active quest 快照上验证失败回滚。
- Task 33.5 的 1000 份独立存档、600 个活跃身份、并发 `[10,25,50,100]` 正式 profile 四档均为 600 请求、0 错误、行为稳定、回滚通过，报告 `admitted=true`。商店列表的 `players_shop_purchase_counters` 读取从单请求 229 次降至 44 次，库存输出保持等价。
- Task 33.6 先定位并修复了 character-bond SQL 结构基线差异：`open_mana_board` 改用事务内已知写后状态构造响应，保留觉醒等级、开板状态和羁绊令牌字段，不再为成功响应重新读取角色主表与令牌表。随后全量回归通过 398 个测试文件、0 失败、0 跳过；类型检查、构建、卫生扫描和独立代码审查均通过。

每个阶段独立提交，不自动 push。若阶段需要改变数据库结构、客户端协议、Active Mission 所有权或事务外部边界，必须停止并重新确认。

## 验收指标

### 行为

- 全量与定向求值逐 mission 结果一致；
- 任务奖励引起的角色、装备、物品进度在同一次 `get_progress` 响应刷新；
- 局部二次求值不再次发奖；
- Category 2 all-clear、Event eventId、Pass event scope、Degree fallback 和 Awake all-complete 保持现有行为；
- 事务失败后进度、stage、奖励和解锁全部回滚；
- Runtime Content 初始化后的 definition、pattern 和 stage 来自同一 repository。

### 结构性能

- 同一求值阶段内，每个规范化 FactKey 的 loader 最多执行一次；
- 同一求值阶段内，每条候选任务最多 compute 一次；
- 标准结算的 `missionBattleCounters` 和相同 `periodicSnapshot` 各最多读取一次；
- 玩家基础事实每阶段最多读取一次；
- category mission progress 每个请求分类每阶段最多读取一次；
- `get_progress` 阶段 B 只计算失效事实反向索引命中的请求内任务；无失效奖励时不创建阶段 B；
- 现有稳定基线的候选、计算、进度、奖励和 SQL 结构不得无解释变化。

延迟 p50/p95 继续作为同机观察值，不写入跨机器硬门槛。验收以 SQL、loader、候选、compute 和结果等价等结构指标为主。

### 分层负载

阶段 4 使用 600 份独立玩家状态，对真实任务入口按 1、10、25、50、100 并发阶梯执行：

- `/mission/get_mission_progress`；
- 单人战斗结算；
- 多人战斗结算；
- 角色羁绊结算。

每档记录吞吐、P50/P95、事件循环延迟、SQL、错误率和事务回滚结果。阶段 4 不把 600 个同时结算请求描述为真实在线流量。

可复核工具为 `tools/perf/mission_entry_layered_load.cjs`，摘要为
`tools/perf/__snapshots__/mission_entry_layered_load_summary.json`，BASE 结构与行为
reference 为 `tools/perf/__snapshots__/mission_entry_layered_load_reference.json`。
其中 `get_progress` 和角色羁绊使用 Fastify 路由；单人和多人使用现有
`mission-finish-boundary` adapter，明确不代表完整战斗 HTTP 混合压测。自动准入检查
`reportStructureValid`、零错误、行为等价、回滚验证、SQL/compute 不增加和
`loadProfileValid`。`reportStructureValid` 要求 playerPool 是结构化记录，其状态数、
每档请求数和非空稠密正整数并发档可安全计算；同时要求 step/entry 计数与结构指标可安全
计算，entry 与 structural 请求数一致，且 step errors 等于四入口 errors 之和；零错误以通过
一致性校验后的 entry errors 为准。缺少 steps/entry、错误类型、NaN 或重复统计矛盾
均安全返回全维度 `false`，不抛出原生类型错误，也不利用空集合伪装通过。其中
`loadProfileValid` 仅在 600 份独立状态、`[1,10,25,50,100]` 五档顺序完整且不重复、
step 与并发档一一对应、每 step 600 请求、四入口的 entry/structural requests 均各
150 时为 `true`；任一条件不满足都会令 `admitted=false`。缩小参数仍可用于 smoke，
并继续执行结构、零错误、行为、回滚和 SQL/compute 检查，但 `loadProfileValid=false`，
不能作为正式准入结果。延迟仅作为同机观察值。
Settlement BASE fixture 与负载 reference 分别由固定无参数 generator
`tools/oracle/generate_mission_settlement_base.cjs` 和
`tools/oracle/generate_mission_entry_load_base.cjs` 从 `f85a01c` Git 对象的隔离归档生成；
普通 benchmark 不提供 reference 写入入口。

整个优化路线完成后再执行全服务混合负载，覆盖登录、load、战斗、商店、抽卡、邮件和生产等价日志级别。联机与 Hub 留到可重复双服环境建立后加入。若混合负载失败，必须先 profile 到具体模块；日志、数据库写锁、商店、CDN 或 Hub 的瓶颈不得通过改造任务类别框架掩盖。

## 已知后续项

- 为 Degree 的 mana、章节、练习、商店和装备事实补齐逐族 scoped 正向矩阵；
- Active Mission 的共享事实、固定点和统一事务协调留到独立 Task 34 Gate；Task 34 不并入普通任务引擎，也不启动数据库物化迁移。
- 跨请求缓存、数据库物化事实和 Content 热切换不在当前路线中。
