# Active Mission 优化设计

> 状态：Task 34 已实施并通过正式性能准入。本文记录设计边界、落地结构与 2026-08-19 验收结果。

## 目标

在不改变客户端协议、任务条件、奖励语义、Active Mission 所有权和现有外层事务边界的前提下，降低 Active Mission 在 `/load`、单人战斗结算、角色故事结算和批量领奖路径中的重复查库、重复主数据解析与全量事实加载。

本 Gate 只优化当前已有权威事实链的 86 条定义。其余 10 条未接入定义、回归资格任务和 `21030` 继续 fail closed，不通过重构顺手推测补全。

## 落地结果

Task 34 最终采用方案 B：保留既有 SQLite 表与外层事务，只拆分运行时职责并按候选任务加载事实。正式结构为：

```text
ContentRepository
  -> ActiveMissionPlan（一次解析、按快照缓存）
      -> ActiveMissionFactSession（一次请求、按 fact kind 惰性加载）
          -> ActiveMissionFactEvaluator（纯计算）
              -> ActiveMissionReconciliationRunner（固定点与依赖调度）
                  -> Reconciler（原事务内写入并返回最终状态）
```

与重构前相比：

- 主数据定义、事件、奖励、QuestRange 与依赖关系由 Plan 预解析，不再在固定点每轮重复构建；
- baseline facts 与候选 facts 分离，每个 fact kind 在一次 Session 中最多加载一次，失败不会污染已加载状态；
- 静态候选只计算一次，依赖型候选仅在目标进度变化后重新计算；
- 未知 pattern 没有 evaluator，也不会触发事实读取，10 条未接入定义继续返回 `null`；
- `/load` 直接复用 reconcile 得到的最终 Active Mission 状态，序列化阶段不再重复读取；
- settlement 中的异常继续向外传播，由原有业务事务整体回滚；没有新增表、迁移或跨请求玩家缓存。

方案 C（物化更多任务事实或调整 schema）没有实施。方案 B 已满足本 Gate 的行为、结构和混合负载准入，继续迁移会增加存档兼容与恢复成本，暂时没有足够收益证据。

## 背景证据

当前 Active Mission 共有 96 条定义、4 个事件。`active-reconciliation.ts` 同时承担事实读取、主数据解析、条件判断、固定点推进、任务写入和增量响应，约 830 行。

当前 `/load` 的 Active Mission reconcile 读取量约为：

```text
19 + C
```

其中 `C` 为玩家持有角色数。主要额外开销包括：

- 对每个角色单独读取 `players_character_quest_clears`，形成明确 N+1；
- 无条件读取 battle counters、conditional facts、loadout facts、角色故事关卡索引和商店主数据；
- 固定点每轮重新解析 mission/event/reward，并重复扫描全部定义；
- pattern 23 对每条定义重复扫描 QuestProgress 和解析 QuestRange；
- 两个战斗事实记录器分别重新解析和扫描 Active Mission 定义；
- `/load` reconcile 后，玩家序列化阶段再次读取 Active Mission 状态；
- 当前 Active Mission 相关玩家表部分使用 `player_id` 非首列主键，存在全表扫描风险，但首版不通过 schema 迁移处理。

### 已验证私服的事实对照边界

Task 34 在性能基线前参考了 `Ku1o/startpoint-cn-private` 的远程 `main`。两边的任务与奖励主数据一致，因此只吸收能由 CN 客户端或结算协议闭合的事实，不直接复制参考服的任务架构。

已采纳并在 34.0 阶段独立修正：

- Active Mission 20007 的第二玛纳板能力节点按 `field6=4/5/6` 判断；
- 觉醒任务 1310052 的 `quest_kind=11` 按客户端 `CharacterAwakeMissionValues` 解析为 Practice 25。

明确不纳入本 Gate 生产逻辑：

- 通过中文角色文本正则推断技能能力；当前 20015/20016 继续使用同一 Content snapshot 的 Action DSL；
- 新增 `players_mission_counters` 物化事实表、跨请求事实缓存或其他 schema 迁移；
- 从请求体重建缺失的 Active Quest；
- Mode15、自制掉落、救援碎片和末期运营奖励映射；
- 救援/新手救援来源事实，留到联机与 Hub Gate 建立可重复房间测试后处理。

参考仓库的 snapshot 主数据索引、按需事实需求和批量角色读取只作为 Task 34 的结构与 fixture 参考；当前 Gate 仍保留既有固定点、事务、RewardGrant 和 fail-closed 语义。

## 已确认边界

### 包含

- snapshot-scoped Active Mission 主数据计划；
- mission、event、reward、pattern、QuestRange 和依赖索引；
- 按需事实需求计划；
- 单次 reconcile 生命周期内的事实 Session；
- 角色 clear 和战斗事实生产入口的批量读取；
- `/load`、单人 finish、story finish 和 `active_mission/receive` 的结构性能基线；
- Task 33 混合负载中的 `/load` 与 single-battle Active Mission overlay；
- Active Mission 专用架构文档与可复核验收报告。

### 不包含

- 10 条未接入定义、回归资格、`multi_special_exchange`；
- 普通任务 Category 1～10 或角色觉醒引擎的再次重构；
- 客户端协议字段调整；
- Active Mission 之外的任务、称号、Pass、库存或奖励语义调整；
- 数据库 schema 迁移、物化事实表和跨请求玩家缓存；
- Content 运行中热切换；
- 联机与 Hub。

## 方案选择

### 方案 A：局部修补

增加批量 character clear 读取、替换主数据线性查找、缓存少量静态表，并保留现有 830 行 reconcile 和无条件事实快照。

优点是改动小、回滚简单；缺点是固定点重复扫描、全量事实读取和职责混合仍然存在，无法稳定覆盖高角色存档。

### 方案 B：分层计划与按需事实（采用）

把 Active Mission 分成四层：

```text
Content snapshot
      |
      v
ActiveMissionPlan
      |  definition/event/reward/pattern/QuestRange/依赖索引
      v
ActiveMissionFactSession
      |  每类事实按需求加载一次
      v
ActiveMissionEvaluator
      |  纯计算，未知条件返回 null
      v
ActiveMissionReconciler
      |  保留固定点、原写入顺序和外层事务
      v
Active Mission delta / 持久化状态
```

首版保留固定点语义，不直接改成依赖队列。先通过静态计划缓存 phase 和依赖信息，再根据证据决定是否进一步优化固定点调度。

### 方案 C：物化事实

业务入口发生时直接写入紧凑事实表，`/load` 和结算只聚合物化事实。

C 的理论读取性能最高，但需要 schema 迁移、各生产入口双写、旧存档回填、事实一致性修复和写放大控制。它作为 B 的后续选择，不作为本 Gate 首版实现。

## B 到 C 的迁移路径

B 不是一次性过渡代码。C 若在 B 完成后确有必要，可以保留：

- `ActiveMissionPlan` 作为主数据和事实需求权威；
- `ActiveMissionEvaluator` 作为计算与校准权威；
- `FactSession` 接口作为事实来源抽象；
- 当前 86 条行为快照、10 条 fail-closed 快照和四条真实流程回归。

C 只需替换 FactSession 的部分 loader，并新增：

1. 物化事实 schema 与版本；
2. 战斗、抽卡、商店、配队、养成等生产入口的双写或切换；
3. 旧存档回填和不可证明事实的保守处理；
4. 原始事实与物化事实的抽样一致性校验；
5. 失败时回退到 B 的原始表 loader。

即使接受一定历史事实损失，影响范围也必须限制在 Active Mission 历史事实和由其计算出的未领取进度。不能影响普通任务、称号、觉醒、Pass、角色、装备、道具、货币、关卡进度或已经发放的奖励。已领取 stage 和库存结果不得因物化迁移被删除。

## 运行时数据流

### Plan

Plan 按 `ContentRepository` 对象身份使用缓存。至少提供：

- mission ID 到解析定义；
- event ID 到解析定义；
- mission 到 reward stage；
- pattern 到定义集合；
- event/phase/need/show/target mission 依赖；
- 已预解析的 QuestRange selector；
- main/ex chapter Quest ID 集合；
- treasure/boss coin 商品集合；
- battle fact recorder 所需定义子集。

缺少定义、重复定义、非法字段、未知 pattern 和无法解析的 selector 继续 fail closed。

### FactSession

FactSession 只存在于一次 `/load`、finish 或其他 reconcile 求值阶段，不跨请求、不跨事务、不做玩家全局缓存。

首版按事实需求加载：

- `player`、`questProgress`、`activeProgress`；
- `characters`、`characterClear`、`manaNodes`；
- `equipment`、`party`、`shopPurchases`；
- `counters`、`battleCounters`；
- `conditionalBattleFacts`、`missionSpecificBattleFacts`。

每个规范化事实 loader 在同一 Session 内最多执行一次。无候选依赖的事实不读取。玩家状态发生写入后，旧 Session 结束，必须新建 Session。

### Evaluator

Evaluator 保持纯函数，不通过惰性 getter 查库。它消费 Plan 和 FactSession，输出：

- 候选 mission ID；
- authoritative progress；
- 已完成 stage；
- fail-closed 原因分类；
- loader、candidate、compute 结构统计。

同一求值阶段内，不依赖其他 Active Mission 状态的候选最多 compute 一次。`target_mission_clear` 等依赖型任务只在其目标任务状态真实变化后重新计算，并单独记录动态 compute 次数；不得在每轮固定点中重新计算全部静态候选。未知事实返回 `null`，不得变成 0。

### Reconciler

Reconciler 继续由现有入口事务拥有，负责：

1. 读取当前玩家/任务状态；
2. 创建 Plan 引用和 FactSession；
3. 执行现有固定点推进；
4. 按原顺序写 progress 和未领取 stage；
5. 返回兼容的 Active Mission delta；
6. 任一步失败由现有外层事务整体回滚。

不得把 `/load` 的 reconcile 改成只返回内存 delta；它仍需修复旧存档和异常中断后的可证明事实。

## 四条验收路径

### `/load`

- New、Small、Large 三档；
- 无变化时 Active 写入为 0；
- 一次新事实、phase 1→2、目标任务级联；
- 10 条未实现定义无进度、无 stage、无写入；
- Active Mission 状态与 Awake category 9 响应隔离。

### 单人战斗结算

- 无 Active 命中；
- Contents Guide `11060`、`11080`；
- 战斗专用事实命中；
- 战斗事实、奖励、经验和 Active Mission 写入一起回滚。

### 角色故事结算

- 首次完成 `11010`；
- 重复完成无重复增量；
- 故事奖励或 Active Mission 写入失败时整体回滚。

### `active_mission/receive`

- 单条、跨任务批量和重复 stage；
- 已领取 stage 与未知 stage；
- 货币、物品、装备、角色、玛纳、经验和称号奖励；
- 领奖状态、奖励、角色觉醒校准和邮件状态故障回滚；
- receive 不创建事实 Session，也不重复计算任务。

## 性能准入

### 固定行为门槛

- 86 条已有事实链的 payload/hash 完全等价；
- 10 条未实现定义继续 fail closed；
- 场景、时间、Small/Large 规模和请求分布固定；
- 无变化场景 Active 写入为 0；
- 重复领奖不重复发奖；
- 每类事实 loader 每次求值最多一次；
- 每个静态事实候选最多 compute 一次；依赖型任务只在依赖状态真实变化后重算；
- 故障注入前后 Active、业务奖励和相关内存状态一致。

### 结构指标门槛

- Large `/load` 的定义访问数严格下降；
- SQL reads 或事实 loader 总量至少一项严格下降，其余不得增加；
- 角色 clear 的 `C` 次读取降为固定批量读取；
- 主数据 definition/event/reward/QuestRange 不在固定点每轮重新解析；
- 无新增触表；
- 延迟、吞吐和 event-loop delay 只作为同机观察值，不设跨机器硬阈值。

## 正式验收结果

正式验收使用固定时间、1000 个互相独立的存档槽位，其中 600 个身份参与每档请求；并发依次为 10、25、50、100。每档均按固定分布执行登录、`/load`、任务进度、单人战斗、商店、抽卡和邮件共 600 次请求，不把 600 个活跃身份误写成 600 个同时并发连接。

四档结果均满足：请求错误为 0、行为签名稳定、故障注入回滚通过、负载结构有效，最终准入为 `admitted=true`。正式准入额外锁定 `/load` 和单人战斗必须各出现 New、Small、Large 三个稳定签名，其余入口必须只有一个签名；overlay 会从实际 `all_active_mission_list` 检查 10 条未实现定义没有非零进度或阶段记录，违反时请求失败而不是只依赖固定计数常量。

| 并发 | 吞吐（req/s） | 全局 p50 | 全局 p95 | Event-loop p95 |
|---:|---:|---:|---:|---:|
| 10 | 33.512 | 93.354 ms | 750.637 ms | 443.286 ms |
| 25 | 35.716 | 340.439 ms | 1831.916 ms | 918.028 ms |
| 50 | 36.336 | 920.685 ms | 3528.159 ms | 1998.586 ms |
| 100 | 36.814 | 2441.278 ms | 6404.382 ms | 2157.969 ms |

Active Mission 相关路径在四档并发中的 SQL 上界稳定：`/load` 最多 52 次读取、9 次写入；单人战斗最多 163 次读取、338 次写入。这里统计的是完整请求而非仅任务引擎，单人战斗的高写入量包含关卡、奖励、库存和任务等业务链，留给后续单人战斗结算 Gate 继续拆解。

延迟和吞吐只记录本机本次运行结果，不作为跨机器性能承诺，也不用于声称相对旧版的固定百分比提升。结构准入由事实 loader 单次加载、批量角色 clear、固定点访问下降和等价性回归共同保证。

### Task 33 衔接

保留 Task 33 的七入口和 1000 存档、600 活跃身份、并发 `[10,25,50,100]` 分布。Task 34 只向既有 `load` 和 `single-battle` 身份叠加确定性的 New/Small/Large Active 状态，并在行为摘要中加入 `all_active_mission_list`。

故事和领奖维持独立 focused profile，不在没有真实比例依据时伪装成第八、第九个等权生产入口。

## 实施阶段

1. 先建立 Active Mission focused baseline、fixture、SQL/loader/compute observer 和准入结构，不改生产逻辑。
2. 建立 snapshot-scoped Plan，迁移主数据查找、解析、reward stage、QuestRange 和 battle recorder 共享。
3. 增加批量 character clear 与目标角色事实读取，保留默认值、legacy fallback 和负数归零行为。
4. 接入按需求 FactSession，先处理无条件 battle/shop/story/conditional/loadout facts。
5. 在不改变固定点语义的前提下缓存 phase/依赖结果，验证固定点级联与回滚。
6. 接入 Task 33 overlay，运行 focused、integration:mission、正式 profile 和全量回归。
7. 最终独立代码审查，按模块 commit，不自动 push。

每个阶段都必须有独立测试和可回滚 commit。任何需要改变数据库 schema、客户端协议、任务所有权或外层事务边界的方案，立即停止并重新确认。

## 残余风险

- Active Mission reconcile 与后续业务任务结算的事务组合仍须逐入口验证；
- 异常导入存档可能含逆序或不完整的历史事实，优化不得借机修正成推测值；
- 数据库 `player_id` 非首列导致的扫描问题记录为后续数据库专项；
- C 迁移即使允许 Active Mission 历史事实损失，也必须保留 B loader 作为回退和校准路径，不能直接删除原始事实来源。
