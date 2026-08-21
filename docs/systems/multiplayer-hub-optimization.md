# 多人联机与 Hub 优化架构

状态：核心优化已实施并通过模块验收；全服务端混合负载待 Task 9

日期：2026-08-20

## 背景

本轮优化面向约 1000 份存档、约 600 名在线玩家的部署场景。此前该规模已经出现过服务端严重卡顿，因此验收不能只证明一间房能够联机，还必须观察集中入房、TCP 活动和多人结算对 SQLite 与 Node.js 事件循环的影响。

现有实现已经具备可信 Host/Client Hub、复合参与者身份、一次性 admission、Client 本地降级、独立可靠发送队列、慢连接隔离、战斗连接租约、接收者快照、战斗代次和远程结算事实。本轮不重复实现这些能力，也不以参考服务器的单服补丁替换当前 Hub 架构。

## 当前架构

```text
游戏客户端
  ├─ HTTP 8001
  │    └─ MultiHttpContext
  │         ├─ embedded / host -> EmbeddedMultiCoordinator
  │         └─ client -> RoutedMultiCoordinator
  │                       ├─ RemoteMultiCoordinator -> Hub control 8004
  │                       └─ Hub 不可用 -> 本地 Coordinator fallback
  │
  └─ TCP 8003
       ├─ Lobby / NPC / Ready
       └─ Battle / Relay / Finalize
                  │
                  └─ BattleFact -> HTTP /finish
                                      │
                                      └─ 本地 SQLite 结算事务
```

本轮已处理权威边界附近的三处成本或维护风险：

1. 玩家快照已改为按去重 ID 批量读取角色、玛纳节点和装备；普通与活动编队一次读取，重复引用不再放大同步 SQLite 查询。
2. 多人 `/finish` 已拆为事务外准备与授权、单事务业务编排、协议响应投影三层，错误码、响应字段和单事务语义保持不变。
3. Client fallback、Coordinator 来源缓存和重赛 NPC 席位均加入明确的代次所有权与故障注入测试；NPC roster 提交后会同步所有已经 Enter 的真人客户端。

## 优化后内部边界

```text
HTTP prepare / TCP admission
          │
          ▼
 readMultiplayerSnapshot()
  ├─ 一次读取 NORMAL / EVENT 编队组
  ├─ 选择目标编队和最多两个 NPC 编队
  ├─ 批量读取角色与玛纳节点
  ├─ 批量读取装备
  ├─ 沿用配队中的 abilitySoulIds
  └─ 生成冻结 PlayerSnapshot
          │
          ▼
 Coordinator + SessionManager
  ├─ 房间、复合身份和 admission 权威
  ├─ Lobby / NPC / reconnect 生命周期
  ├─ battleSessionId / sceneGeneration
  └─ 每连接可靠发送队列
          │
          ▼
 prepareMultiplayerSettlement()
  └─ 事务外验证 Hub BattleFact
          │
          ▼
 runMultiplayerSettlementOrchestration()
  ├─ 事务内重新读取玩家权威状态
  ├─ 调用现有奖励与任务公共层
  └─ 清理 active quest
          │
          ▼
 projectMultiplayerFinishResponse()
  └─ 生成一次性响应投影
```

本轮没有改变客户端协议，也没有把 SQLite 结算异步化。所有玩家数据仍由所属服务端处理；Hub 不读取或复制玩家数据库。多人结算继续采用单个 SQLite 事务，且必须先取得 Coordinator 授权事实，再开始本地写事务。

## 实施边界

### 玩家快照

- 快照读取器一次取得 NORMAL 与 EVENT 编队组，再从中选择目标普通编队和最多两个 NPC 编队。当前优化固定了 SQL 次数，但没有把编队域读取缩小为单个目标槽位。
- 角色、玛纳节点和装备按 ID 集合批量读取；同一 ID 在一次快照中不得重复查询。魂珠 ID 直接沿用已经通过配队写入校验的 `abilitySoulIds`，快照层不重复查询库存或重新校验持有量。
- 输出字段、顺序、缺失数据的 fail-closed 行为和深冻结语义保持不变。
- SQL 基线覆盖唯一资源和重复资源；残缺资源的 fail-closed 由快照行为测试覆盖。墙钟延迟不作为跨机器硬门槛。

### 多人结算

- 路由只负责协议输入和最终发送；结算编排器拥有业务顺序。
- Hub/Embedded Coordinator 的 BattleFact 必须在打开本地写事务前验证。
- 事务开始后重新读取余额、active quest 和必要玩家事实，不能复用跨网络等待前的可变状态。
- 奖励、经验、任务、觉醒和 active quest 清理继续同成同败。
- 响应丢失后的重试只能复用仍被保留的权威事实；不得在 Hub 写入结果不确定时切换到本地重放。

### 生命周期

- Client 只对后续新房间在 remote 与 local 之间切换，现有房间和 active quest 不迁移。
- fallback 探测使用单飞请求；本地 TCP 瞬时启动失败后按默认 1 秒冷却重试，不形成高频探测或启动循环。
- Coordinator 来源缓存必须带所有权代次或过期边界；旧房间回调不得清理复用后的新来源。
- 真人大厅断线继续保留 25 秒宽限。只有房间仍处于 NPC 模式、旧成员资格已由权威层释放且当局未开始时，才允许补齐 NPC。
- 重赛回到大厅时重新核对当前真人席位与 NPC roster；NPC 模式仍开启且存在已释放空位时，按同一权威规则补齐。旧 Enter、旧招募请求、旧 timer、上一场 NPC 和已释放真人均不能占用新一轮席位。
- NPC roster 正式提交后，同步所有已经完成 Enter 的房间客户端；尚未 Enter 的连接仍走原有 Welcome 初始化顺序。
- 真实随机招募启用前不新增救援席位预留或通知行为。

## 明确不纳入本轮

- 真实随机招募、公开房间列表、救援通知和 `RealMateProvider`；
- 历史成功编队 AI 池、AI 战力或属性筛选；
- 社交、关注或跨服好友关系；
- 房间和 TCP 会话的进程重启恢复；
- 外置数据库、消息队列、分布式锁或可横向扩展 Coordinator；
- 完整 TCP 业务载荷日志。诊断只允许记录有界结构字段，不记录消息正文、设备码或凭据。

上述功能需要独立的官方功能 Gate。特别是随机招募上线前，必须先在 Coordinator 权威层设计原子席位预留，不能直接照搬只适用于单服内存房间的救援席位表。

## 验收

模块级门禁包括：

- 多人专项行为签名保持一致；
- 快照 SQL 读取次数有确定上界且不随队伍中重复引用线性增长；
- Hub 验证发生在本地写事务之前；
- 故障注入证明奖励、任务和 active quest 不产生半状态；
- 慢连接、连接替换、旧 timer、旧来源缓存和 NPC 延迟回调不能影响新代次；
- 重赛回房后按当前权威席位补齐 NPC，已离开的真人、上一场 NPC 和旧招募请求均不能重复占位；
- 双服运行器结束后活动连接、房间、临时数据库和子进程全部归零。

本轮检入的 fixture 结构门禁如下；各表细分计数仍以 `tools/perf/__snapshots__/` 中的 JSON 为权威，这些数字不是所有请求形态或跨机器性能的全局常量：

- 生产玩家快照由 `68 SELECT` 降为固定 `7 SELECT`；重复资源场景的依赖调用由 `48` 降为 `6`，四个场景的输出签名均保持不变。
- 多人 finish 为 `55 SELECT + 24 写入 + 12 事务控制 = 91` 条语句，HTTP 状态为 200，Hub 验证先于事务且 active quest 已清理；完整响应协议签名为 `sha256:6251057102cadbbc480793acf2f3a111f18d9844c9210191b3b71a013d0cce0e`。
- Hub 正常基线为 1 房、2 peer、完成 1、错误 0；故障基线为 2 房、4 peer、注入 2 次 Client 断线、完成 2、错误 0。两者清理后 peer、房间和子进程均归零，临时目录不存在。
- 同机三轮比较中，多人 finish 延迟中位数约退化 4.2%，事件循环延迟中位数约退化 9.3%；Hub 的 p95/p99 三轮中位数分别为握手约退化 3.3%、心跳约退化 13.7%、准备阶段约改善 2.0%，均满足 20% 准入线。

Task 9 的最终性能验收尚未执行。它将准备约 1000 份隔离存档，以 600 个活跃身份及分档并发模拟混合登录、建房、入房、TCP 心跳和结算负载，不把 600 个活跃身份描述成 600 个请求或 TCP 连接同时并发。验收记录吞吐、错误数、事件循环延迟、SQLite 读取/写入和 p50/p95/p99；准入要求请求错误和半状态均为 0，场景完成数与输入一致，活动连接、房间、临时数据库和子进程归零，各场景 SQL 次数不超过检入上界，快照读取不得随重复角色或装备引用产生 N+1 增长。

延迟比较只在相同机器、Node 版本、Content snapshot 和数据库 fixture 下作为门禁：预热后分别运行三轮，取每轮 p95/p99 和事件循环延迟的中位数；优化后任一中位数相对同 Gate 的变更前基线退化超过 20% 即不准入。跨机器墙钟数据只作观察，不作为硬门槛。只有结构门禁通过但该同机性能门禁仍不能满足时，才讨论持久化或外置 Coordinator。

客户端人工验收在全部模块重构结束后统一进行，不阻塞每个内部模块的自动回归和独立提交。
