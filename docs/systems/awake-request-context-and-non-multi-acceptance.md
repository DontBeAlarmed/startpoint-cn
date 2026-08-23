# 觉醒请求上下文与非多人总验收架构

状态：35.4 已完成分层验收；35.5 尚未验收

日期：2026-08-24

## 背景

本项目曾在约 1000 份玩家存档、约 600 名在线玩家的部署规模下出现严重卡顿。前序[任务引擎演进架构](./mission-engine-architecture.md)已经完成 Catalog、FactKey、`MissionEvaluationSession`、定向候选和求值结果复用，[数据库热路径第一阶段优化](./database-hot-path-optimization.md)也已经完成玩家维度索引、批量快照和有界写入。本 Gate 不重做这两层，而是收敛它们之间仍然存在的觉醒 publication/reconcile 重复读取，并完成非多人性能总验收。

当前觉醒 publication/reconcile 在典型无失效路径仍固定产生约 14 次读取。主要重复工作包括：

- publication 重新全量读取玩家角色和玛纳节点，与 owner 刚完成的权威写后状态重复；
- Category 9 先在任务或战斗结算中求值一次，又在 unlock publication 中进行第二轮求值；
- 角色、任务和 FactKey 已经可以定向，但 reconcile 仍重新构造全量角色上下文；
- unlock 写入结束后再次全量读取 unlock 表，只为返回 `all` 结果；
- player、quest progress、character clear 和 party co-clear 即使候选任务不依赖，也会被无条件加载。

这些固定读取在单请求中看似有限，但会被高频任务、战斗、养成、奖励和 600 个活跃身份放大。前序 Gate 已证明任务求值可以按候选和 FactKey 组织，也证明数据库索引和批量接口能够稳定承载玩家范围查询；下一步应复用这些边界，而不是建立新的长期缓存或第二套任务引擎。

## 目标

本 Gate 建立请求级 Awake context，并以它作为 publication/reconcile 的唯一权威输入：

1. owner 收集并冻结本次可能受影响的候选角色、候选任务、依赖闭包和 FactKey；
2. 只在本次主业务最后一次权威写入完成后创建新鲜 context；
3. context 创建新的 `MissionEvaluationSession`，按候选任务及其 FactKey 加载必要事实；
4. owner 已持有同一请求内的权威写后快照时，将快照注入 context，避免再次查库；
5. scoped evaluator/reader 只处理冻结范围，publication 复用同一份求值与 unlock 写后结果；
6. reconcile 完成或失败后立即销毁 context，不允许跨请求、跨事务或跨求值阶段复用。

“最后一次权威写入”指 owner 在进入觉醒 reconcile 前，对玩家、角色、玛纳节点、任务事实、关卡履历、奖励和业务状态完成的最后一次主业务写入。reconcile 自身的 unlock 写入不在该定义内。

## 明确非目标

- 不改变任务条件、开放规则、奖励内容、幂等语义或客户端协议；
- 不改变数据库表结构，不增加事实物化表；
- 不建立跨请求、跨事务或常驻进程级玩家缓存；
- 不引入异步队列、通用 Unit of Work 或 Active Mission 方案 C；
- 不进行多人联机或 Hub 性能架构重构；
- 不缩减 `/load` 的全量存档恢复和历史修复语义；
- 不借本 Gate 改写多人协议、任务生产者、奖励公共层或数据库所有权。

## 架构对比

旧链路在 owner 已经完成写入后，再从数据库重建一套全量觉醒视图：

```text
请求 owner
  -> 主业务与任务事实写入
  -> Category 9 第一轮结算
  -> reconcileAwakeUnlockCharacterList
       -> 全量角色 + 全量玛纳节点 eligibility
       -> 全量 Category 9 mission progress
       -> 全量角色 + player + quest + clear + co-clear context
       -> Category 9 第二轮求值
       -> unlock 清理 / UPSERT
       -> unlock 全量尾读
  -> 合并 character_list
```

新链路由 owner 先声明范围，再在最后一次权威写入之后建立短生命周期的新鲜上下文：

```text
请求 owner
  -> 收集候选角色 / 任务 / FactKey seed
  -> 主业务与任务事实最后一次权威写入
  -> 冻结 scope
  -> 创建 fresh Awake context
       -> 校验 player 身份与 seed 完整性
       -> 注入本请求权威写后快照
       -> 创建 fresh MissionEvaluationSession
       -> scoped loaders 补齐未注入的声明事实
       -> 一次 Category 9 求值与 reconcile
       -> 复用 unlock 写后结果生成 publication
  -> strict 返回或 best-effort savepoint 收束
  -> 销毁 context
```

## 组件职责

### Scope 收集与冻结

scope collector 由生产 owner 驱动，职责是收集“哪些状态可能改变”，而不是读取数据库或执行任务计算。关键输入包括玩家身份、业务动作、实际变化的角色或任务、奖励带来的失效事实，以及 owner 能证明来源的新鲜写后快照；输出是不可再扩张的 reconcile 计划。

冻结结果至少表达：

- 候选角色与候选 Category 9 任务；
- all-complete 等任务的完整依赖闭包；
- 规范化、去重后的 FactKey 集合；
- 可选的权威写后快照及其来源声明；
- strict 或 best-effort publication 策略。

接口只锁定职责和关键输入输出，不预先规定具体类名、容器类型或 builder 形态。实施可以复用现有任务引擎对象，但不得让 scope 在 context 创建后继续变化。

### Fresh MissionEvaluationSession

Awake context 必须创建新的 `MissionEvaluationSession`，固定玩家身份、求值时间、当前 Content snapshot、候选及依赖。写前创建过的 Session 即使尚未读取全部事实，也不得复用，因为其计划、缓存或已加载值无法证明反映最后一次权威写入。

Session 只接受冻结 scope 声明的事实。Computer 继续保持纯计算；未声明事实不得在计算阶段隐式查库。all-complete 的 session 计划必须递归纳入全部子任务及其 FactKey，不能只装载父任务自身需求。

### Scoped evaluator 与 reader

scoped evaluator 按候选任务及依赖闭包求值，scoped reader 按 FactKey 参数读取角色、任务、关卡或计数范围。无参数的全量读取只能用于事实本身无法安全缩小，或 owner 无法证明候选范围的入口；此时必须在静态审计矩阵中记录入口、全量原因和对应 SQL 上界。

同一请求内的权威写后快照优先于数据库重读。注入值必须与 context 的玩家身份、Content snapshot 和 scope 一致；未注入的声明事实由新鲜 Session 在最后一次权威写入后同步加载。reader 不得为了实现方便重新加载未声明的 player、quest、clear 或 co-clear 全量事实。

### Strict publication

strict publication 用于觉醒结果属于主业务原子语义的入口。scope、求值、unlock 清理或写入、响应投影任一步失败，都必须抛到原外层事务并回滚主业务。strict 不创建吞错边界，也不在失败后返回旧 `character_list`。

### Best-effort publication

best-effort publication 用于主业务已经可以独立成立、觉醒只负责响应协调的入口。它必须在 reconcile 专用 savepoint 内执行；失败时只回滚该 savepoint 中的 unlock 清理或写入，保留 owner 主业务，记录有限错误并返回 owner 已有的 `character_list`。不得让失败的部分 unlock 写入残留，也不得回滚已完成的主业务。

事务内 best-effort 的 savepoint 位于原外层事务内部；提交后 best-effort 使用自己的短事务或等价 savepoint 边界。两类入口的业务提交时点保持不变。

### `/load` 全量恢复

`/load` 是独立的全量恢复 owner。它继续读取完整角色、节点、Category 9 进度和 unlock 状态，重算所有当前可见觉醒任务，并清理不再满足资格的历史 unlock。该链路可以复用新的 evaluator/reader 组件，但不能被候选 publication 的局部语义替代，也不能依赖上一个请求遗留的 context。

## 一致性与失败边界

以下约束均为实施硬条件：

- context 只能在本次主业务最后一次权威写入后创建；创建时点必须由 owner 明确控制；
- 任意写前 Session、eligibility resolver、角色视图或事实缓存均不得注入或复用；
- context 的玩家身份与 owner/player 不一致时必须抛错；
- owner 一旦声明某组 seed 或写后快照，缺项、范围不完整、来源不明或与冻结 scope 不一致时必须抛错，不能静默回退为混合新旧数据；
- strict 失败随原外层事务整体回滚；best-effort 失败只回滚 reconcile savepoint，并保留主业务；
- 未知、冲突或无法证明依赖的主数据继续 fail-closed，不得因 scoped 加载放宽任务完成条件；
- 空候选不等于无工作。现有语义会删除已不再 ready 且没有正 awake level 支撑的历史 unlock，因此空候选仍须执行有界资格检查和解锁清理，不能直接以零 SQL 返回；
- all-complete 的候选闭包必须包含全部子任务、子任务持久化进度和子任务 FactKey；任一依赖缺失都必须 fail-closed；
- unlock publication 使用 reconcile 已知的写后结果生成 `changed`、`removed` 和响应，不得为获得 `all` 再做无条件全量尾读；只有 `/load` 的全量恢复需要完整 `all` 视图；
- context 在成功、strict 抛错或 best-effort 回退后都必须释放引用，不得注册到进程级 map、session 或后续请求。

## 生产调用边界

当前生产代码约有 19 个 `reconcileAwakeUnlockCharacterList*` 调用表达式。实施前必须建立并锁定静态审计矩阵，逐表达式记录 owner、事务位置、候选来源、注入快照、策略和 SQL 上界；迁移后不得保留未登记的 legacy 调用。无法证明候选范围的入口允许暂时使用全量 scope，但必须记录具体理由，不能以“兼容”为笼统说明。

| 边界 | 现有调用表达式 | 目标 owner 与上下文来源 | 失败语义 |
|---|---|---|---|
| 事务内 strict | `src/routes/api/character/mana.ts` 的 `character/learn_mana_node` | 玛纳节点、材料、角色进化、bond 与任务事实完成最终写入后冻结；注入目标角色、节点及 owner 已知写后状态 | 任一 context、求值、unlock 或投影错误回滚整个 learn 事务 |
| 事务内 best-effort | `src/lib/quest/finish/single-settlement-writes.ts` 的单人 finish、`src/multi/settlement/orchestrator.ts` 的多人 finish | 结算奖励、角色经验、关卡履历和任务事实完成后，以本场主副角色、direct mission IDs 和写后事实冻结 | 只回滚 reconcile savepoint，主结算保留 |
| 事务内 best-effort | `src/routes/api/storyQuest.ts` 的 story finish、`src/routes/api/character/bond.ts` 的 `character/receive_bond_token` | story 加入角色或 bond 写入后，以实际变化角色和任务事实冻结 | 只回滚 reconcile savepoint，story/bond 主业务保留 |
| 事务内 best-effort | `src/routes/api/mail.ts` 的 `mail/receive`、`mail/receive_all` | 所有附件、领取历史和邮件状态写入后，以实际角色奖励和 FactKey 失效冻结 | 只回滚 reconcile savepoint，邮件领取事务继续提交 |
| 事务内 best-effort | `src/routes/api/activeMission.ts` 的 Active Mission 领奖 | stage、奖励和 player 持久化后，以实际角色奖励和 FactKey 失效冻结 | 只回滚 reconcile savepoint，Active Mission 领奖保留 |
| 事务内 best-effort | `src/routes/api/tutorial.ts` 的 tutorial 15、tutorial 16 | 教程抽卡或赠送角色及 player 写入后，以新增角色冻结；publication 投影完成后再持久化不改变 context facts 的响应 receipt | 只回滚 reconcile savepoint，教程主业务与幂等 receipt 保留 |
| 提交后 best-effort | `src/routes/api/mission.ts` 的 `mission/update_mission_progress`、`src/routes/api/item.ts` 的 `item/sell` | 原事务或同步 owner 返回后，分别以实际 Category 9 变化或 Mana item sell 失效事实建立短生命周期 context | publication 失败不撤销已提交主业务 |
| 提交后 best-effort | `src/routes/api/shop.ts` 的 `shop/buy`、`shop/bulk_buy` | 购买提交后，以 reward result 中实际变化角色与事实键冻结 | publication 失败不撤销购买 |
| 提交后 best-effort | `src/routes/api/gacha.ts` 的 `gacha/exchange_character`、`gacha/exec` | 兑换或抽卡提交及延迟日志边界完成后，以实际角色结果冻结 | publication 失败不撤销兑换、抽卡或日志所有权 |
| 提交后 best-effort | `src/routes/api/boxGacha.ts` 的 `boxGacha/exec`、`src/routes/api/exchange.ts` 的 `exchange/star_crumb` | 主业务提交后，以实际抽中或兑换角色及奖励失效冻结 | publication 失败不撤销箱状态或兑换 |
| 提交后 best-effort | `src/routes/api/character.ts` 的 `character/add_character_from_town` | town 角色发放提交后，以实际新增角色及写后快照冻结 | publication 失败不撤销角色发放 |
| 独立全量恢复 | `/load` | 从当前数据库和 Content snapshot 创建独立 full-recovery context，不接受其他请求 seed | 任一恢复错误沿既有 `/load` 错误边界失败，不降级为局部视图 |

上述分组依次包含 1 个事务内 strict、9 个事务内 best-effort 和 9 个提交后 best-effort 表达式。单人/多人 finish 虽共同使用结算抽象，静态审计中仍按两个生产表达式分别锁定；tutorial 15/16、邮件单领/全领、shop 单购/批购和 gacha 兑换/执行同理。

## 性能与行为门禁

### 35.0 publication/reconcile reference

35.0 使用 bundled gameplay snapshot 和固定服务器虚拟时间
`2025-01-01T12:00:00.000Z`，在五个互相独立的临时 SQLite 数据库中固化当前
publication/reconcile 行为。计量窗口只覆盖目标调用；fixture 准备和行为摘要读取不计入
SQL 或 mission compute。reference 位于
`tools/perf/__snapshots__/awake_request_context_baseline.json`，只能由
`npm run benchmark:awake-request-context -- --write` 在结构、行为 hash 和场景集合自洽后原子更新。

| 场景 | SQL reads | SQL writes | mission computes | behavior SHA-256 |
|---|---:|---:|---:|---|
| `full-publication` | 14 | 1 | 7 | `6968f3ca45d53d4e9e96e8d307db067ef4a7fde04baa7fb3b8b15386e8dbb481` |
| `candidate-one` | 28 | 2 | 14 | `3ee3ee50e4a7d1372448eefa2e0d6b3d40b5d1d56b78f2ca9035b1f09cc2c8b1` |
| `empty-candidate-cleanup` | 6 | 1 | 0 | `bbbcbc055cad69b216b3b1d2ff14bb7bdabd7abcb9be4ef622c9eb22fbc92b3b` |
| `strict-failure-rollback` | 13 | 2 | 7 | `85c0693a4e815a0ddebe51ce6f91d7334fc69c25a6561222cc4d790431ec6c84` |
| `best-effort-failure` | 13 | 2 | 7 | `0469485bfdf8cb1d6b7f05fe94873b960e14d3baacf0f7440698a98cdd71ef31` |

实测行为同时固定了以下现状：full publication 返回角色 341005 的完整响应投影，其中
`join_time` / `update_time` 均为 `2025-01-01 12:00:00`，并持久化 board 1 / awake level 1；
候选 API 首次返回 `changed`，第二次幂等且两次均返回完整
`all`；空候选会删除不再 ready 且没有正 awake level 支撑的历史 unlock；strict 写故障使
owner 的 Mana 写和 reconcile 写全部回滚；best-effort 同类故障返回原
`character_list`，保留 owner 的 7 Mana 写入，并回滚 reconcile 的历史删除和候选插入。
两个故障场景均以 `injectedFailureObserved: true` 固定实际命中了预期 unlock 写故障；目标
`Error` 必须同时具有精确 message `injected awake unlock write failure` 和 code
`SQLITE_CONSTRAINT_TRIGGER`，best-effort 还必须通过固定前缀加该 `Error` 的双参数日志形状，
否则 runner 失败。
snapshot 还逐场景固定了稳定表名及 `reads`、`writes`、`statements`；新增业务表或任一既有
结构指标上升均拒绝准入。故障场景中的 owner `players` 更新处于同一个外层事务，但不在
`measureTarget` 窗口内；reference 中的 `players` 仅记录 publication 自身的 1 次读取和 0 次写入。

TypeScript AST 静态审计固定了 19 个生产 `CallExpression`：1 个事务内 strict、9 个事务内
best-effort、9 个提交后 best-effort。审计不统计
`awake-unlock-response.ts` 的定义和内部调用，并逐表达式固定 relative file、callee、owner、
事务边界、当前 publication 的 `scoped-context` 来源与候选来源短标识。35.0 不把旧链路
loader 次数记为相对门禁；“每请求最多一次”由 35.1 的显式 Session observer 验收。

### Focused 门禁

focused 场景必须至少覆盖：

- 候选为 0、1 和多个角色；
- learn mana 的最后一个节点；
- bond 领取；
- Category 9 任务进度；
- story finish；
- Mana item sell；
- 发放角色的奖励入口；
- single finish。

每个场景固定请求 payload、响应 payload/hash、数据库前后状态、候选、FactKey、loader 次数和 SQL reads/writes。相对 35.0 reference，实际触发旧 publication 重读的场景必须让目标 SQL reads 与重复 loader 严格下降；其余场景至少不得增加。候选增加时允许有界读取随候选范围变化，但不得退回按全部角色、全部节点或全部 Category 9 任务放大。任何上界变化都必须由审计矩阵中的候选或依赖闭包解释。

行为门禁要求响应 payload/hash、任务与 unlock 幂等、事务回滚、best-effort 回退和重复请求结果保持不变。focused 通过只证明确定性场景，不宣称正式容量收益。

### 轻量回归

轻量 profile 保持 7 份存档、7 个活跃身份，只用于快速检查 auth、load、mission、single、shop、gacha、mail 七类旅程、SQL 上界、行为签名、回滚与资源清理。它不是容量测试，不用于建立或更新正式 reference，也不能据墙钟结果宣称生产性能改善。

### 正式非多人验收

formal profile 使用 1000 份互相独立的存档、600 个活跃身份，并发档固定为 `[10,25,50,100]`，每档完成 600 个请求。并发数表示同时在途上限，不表示 600 个请求同时开始。

执行顺序为：

1. 在 35.0 固定 Content snapshot、机器指纹、Node 版本、profile、行为签名和 SQL 上界 reference；
2. 实施后先运行一轮 formal 预飞，发现结构、清理或资源问题时停止，不把该轮计入最终结果；
3. 预飞通过后连续运行三轮正式验收，三轮不得选择性丢弃或拼接。

最终三轮的每一轮都必须同时带现有多人/Hub 回归哨兵：120 个独立多人身份、60 个双人房间，保持既有双向房主分布、协议流程、HTTP 共存和清理检查。该哨兵只证明本 Gate 没有破坏多人与 Hub，不代表本 Gate 修改、优化或重新验收联机架构。

以下为硬门禁：

- 所有 HTTP、任务、房间、TCP、结算和清理错误均为 0；
- 非多人及多人行为签名与各自 reference 一致；
- focused、轻量和 formal 的 SQL/loader 上界满足准入规则；
- strict 故障注入保持整体回滚，best-effort 故障注入只回滚 reconcile savepoint；
- active quest、peer、room、socket、子进程、数据库句柄和临时运行资源全部清理；
- 同一机器、相同 Node、Content snapshot 和 formal profile 下，最大并发档 p95 的三轮中位数相对 reference 不得退化超过 20%。

跨机器墙钟只记录观察，不作为准入或架构升级依据。即使墙钟变快，也不能替代行为、SQL、回滚和资源清理证据；即使墙钟单项偏高，也不能单独触发更大架构改造。

## 执行阶段

| 阶段 | 范围 | 完成证据 |
|---|---|---|
| 35.0 规格与基线 | 固化本规格、约 19 个生产调用表达式静态审计矩阵、focused/轻量/formal profile 与同机 reference | 已完成；基线与矩阵提交在前序本地 commit 中 |
| 35.1 核心 context | 实现 scope 收集/冻结、fresh context、Session、scoped evaluator/reader、seed 校验和生命周期清理 | 已完成；请求 context 与专项回归已通过 |
| 35.2 事务内 owner | 迁移 learn strict，以及 finish、story、bond、mail、Active Mission、tutorial 的事务内 best-effort owner | 已完成；事务边界与 savepoint 专项回归已通过 |
| 35.3 提交后 owner 与 `/load` | 迁移 mission、item、shop、gacha、boxGacha、exchange、character/town；保留 `/load` full recovery | 已完成；提交后故障注入、独立 full recovery、active mission fixture 兼容和 workflow 精确分组回归通过 |
| 35.4 分层验收 | 运行 focused、7/7 轻量回归和一轮 formal 预飞 | 已完成；行为、SQL/loader、回滚、清理和 profile 结构均准入，详见下方实测证据 |
| 35.5 终审与正式验收 | 独立终审；只运行一次 `npm run verify:full`；随后执行带多人/Hub 哨兵的连续三轮正式验收并回填结果 | 尚未执行；不得据当前证据标记通过 |

35.0 至 35.5 每个阶段完成后各自创建本地 commit，均不 push。任一阶段未满足自己的证据要求时不得标记完成，也不得把后续阶段的测试结果回填到前一阶段冒充通过。

## 停止条件与第二阶段触发

当 focused、轻量、单轮预飞、一次 `verify:full` 和带多人/Hub 哨兵的连续三轮正式验收全部通过时，本轮非多人性能重构即结束，不继续寻找抽象升级点。

只有在全部行为与清理门禁保持通过后，仍能把失败定位到具体生产入口，并提供按表 SQL 计数、`EXPLAIN QUERY PLAN` 全表扫描或 SQLite 写锁竞争证据，才允许立项“数据库热路径第二阶段”。立项材料必须说明入口、表、查询或写锁、同机复现方式及预期边界。

单项墙钟高、跨机器结果差异、主观卡顿感受或“可能还有优化空间”均不足以升级架构。没有上述数据库证据时，不引入异步写入、通用 Unit of Work、长期缓存、外置服务或多人/Hub 重构。

## 文档回填规则

本文件记录已确认设计、35.0--35.4 的实现与验收状态，不声称最终性能收益。35.3 的实现提交为
`59c131ca refactor(mission): scope post-commit awake owners`；对应专项证据包括
`tools/active_mission_reconciliation.test.cjs`、`tools/load_awake_full_recovery.test.cjs`、
`tools/post_commit_awake_owner.test.cjs` 和 `tools/test-workflow/select-tests.test.cjs`。

### 35.4 实测证据（2026-08-24）

验收环境为 Node.js `v22.23.1`、Darwin x64、8 个逻辑 CPU。以下命令均从
`starpoint-cn` 仓库根目录执行；本轮没有运行 `verify:full`，没有使用 `--write` 或
`--write-reference`，也没有执行 35.5 的连续三轮 formal 验收。

focused 使用 `npm run benchmark:awake-request-context`，退出码为 0，用时 6.33 秒。
固定场景集合 `full-publication`、`candidate-one`、`empty-candidate-cleanup`、
`strict-failure-rollback`、`best-effort-failure` 全部准入，行为 payload/hash 与检入
snapshot 一致；五个场景的 `SQL reads/writes/mission computes` 分别为 `11/1/7`、
`18/2/14`、`5/1/0`、`11/2/7`、`11/2/7`。两个故障场景均实际命中注入点，strict
保持 owner 与 unlock 整体回滚，best-effort 保留 owner 的 7 Mana 写入并回滚 reconcile
savepoint。随后运行
`node --test tools/awake_request_context.test.cjs tools/mission_awake_session.test.cjs`，
30/30 通过，用时 8.03 秒，复核候选 0/1/多、请求 context 生命周期、Category 9
快照复用以及每种已使用事实 loader 每个 Session 最多调用一次。

轻量回归使用
`npm run benchmark:non-multi-mixed -- --output <WORKSPACE_ROOT>/docs/reports/task-35.4/non-multi-mixed-smoke.json`，
退出码为 0，用时 10.28 秒。profile 为 7 份独立存档、7 个活跃身份、并发 `[2]`；
auth、load、mission-progress、single-battle、shop、gacha、mail 各完成 1 个请求且错误为 0。
各入口 `readsMax/writesMax` 依次为 `8/3`、`46/6`、`14/1`、`111/29`、`26/5`、
`69/8`、`18/4`，行为签名稳定且写入口回滚验证全部通过。轻量报告的
`loadProfileValid:false` 和 `admitted:false` 是其不冒充 formal profile 的既定结果；
结构、零错误、行为稳定和回滚四项检查均为 `true`。本地报告 SHA-256 为
`73af1ae10b304876eab50ca7cc8a4209a4f6c25891b6344891e9b221e1e5a843`。

单轮 formal 预飞使用
`npm run benchmark:full-server-acceptance -- --formal --rounds 1 --output <WORKSPACE_ROOT>/docs/reports/task-35.4/full-server-formal-preflight-round-1.json`，
退出码为 0，用时 235.83 秒。非多人 profile 为 1000 份独立存档、600 个活跃身份、
并发 `[10,25,50,100]`，每档均完成 600 个请求且错误为 0；四档 p95 分别为
`680.738`、`1643.004`、`3216.023`、`5943.13` 毫秒。跨四档各入口最大
`readsMax/writesMax` 为 auth `8/3`、load `46/9`、mission-progress `14/1`、
single-battle `141/102`、shop `26/5`、gacha `74/9`、mail `18/4`；非多人报告的结构、
零错误、行为稳定、回滚和 formal profile 检查全部通过。

现有 full-server runner 将 formal 多人/Hub 哨兵作为不可分割子流程，因此本次预飞也按其
既有职责运行了 120 个身份、60 个双人房间和并发 `[5,10,20]`。每档均完成 60 个房间和
120 个玩家，双向房主各 30 个房间，协议/HTTP 共存、重复结算拒绝、行为签名与清理检查均
通过；每档结束后的 active quest、peer、子进程和剩余房间均为 0，端口已释放且临时根目录
不存在。整轮 `structuralAdmitted:true`、`admitted:true`，报告 SHA-256 为
`1da2b86c51e8fdeb5851d324556fecceaf7d6b861ae5a4d4afa0fbd5af3fe6ca`。

该 formal 结果只是一轮预飞，不计入 35.5 的连续三轮。`referenceComparable:false` 是
单轮报告的既定状态，因此本节不据 observed ratio 或墙钟声明最终 p95 门禁、容量收益或生产
性能改善。验收前后 `awake_request_context_baseline.json` 与
`full_server_acceptance_reference.json` 的 SHA-256 分别保持
`a4fabbed0d5dcc8e822aa8cc48b41e7f10c60af0d77e30a8591bdb4c93a7dcc4` 和
`05f06ff9f3c7d4dfb6f113eabb2a7f42c6bb04d97eae03c95500ac4aff639299`，未写入 reference。
