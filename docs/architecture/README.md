# StarPoint CN 当前架构图集

本目录用图示补充[当前运行时架构](../architecture.md)，聚焦稳定职责、权威状态、事务边界和跨进程协议，不重复完整的模块说明、功能状态或协议字段表。

## 图集索引

| 编号 | 主题 | 文档 | 关注点 |
|---|---|---|---|
| D1 | 系统总览 | [系统总览](./system-overview.md#d1-当前系统总览) | 外部边界、服务进程、Content、SQLite 与资源供给 |
| D2 | 任务结算流水线 | [任务结算](./mission-and-single-battle.md#d2-当前任务结算流水线) | Category Mission 的准备、求值、写入与阶段 B |
| D3 | 单人战斗生命周期 | [单人战斗](./mission-and-single-battle.md#d3-当前单人战斗生命周期) | `/start`、客户端战斗、`/finish` 的事务和内存状态时序 |
| D4 | 奖励与库存写入 | [奖励与库存](./rewards-and-growth.md#d4-当前奖励与库存写入) | RewardGrant 的不可变计划、事务入口与领域写入 |
| D5 | 角色与装备养成 | [角色与装备养成](./rewards-and-growth.md#d5-当前角色与装备养成) | 角色节点、普通装备觉醒与追忆强化的独立规划语义 |
| D6 | 账号、设备绑定与 session | [身份与 session](./identity-time-and-load.md#d6-当前账号设备绑定与-session) | 设备注册、session 优先身份和默认 player |
| D7 | 全局服务器时间与双时钟 | [双时钟](./identity-time-and-load.md#d7-当前全局服务器时间与双时钟) | 虚拟业务时间、真实经过时间与基础设施计时 |
| D8 | CN `/load` | [CN load](./identity-time-and-load.md#d8-当前-cn-load) | 登录维护、active quest 恢复和完整快照聚合 |
| D8b | V2 存档恢复 | [V2 存档恢复](./identity-time-and-load.md#d8b-当前-v2-存档恢复) | Registry、排除域与单事务替换 |
| D9 | 启动与关闭生命周期 | [运行时生命周期](./runtime-lifecycle.md#d9-当前启动与关闭生命周期) | Content 前置、运行时顺序与有界关闭 |
| D10 | 多人联机与 Hub 当前拓扑 | [多人联机与 Hub 拓扑](./multiplayer-current.md#d10-当前多人联机与-hub-拓扑) | 两个服务节点、三类监听、各自 SQLite 和新房间降级 |
| D11a | 多人建房与开战 | [建房与开战](./multiplayer-current.md#d11a-当前多人建房与开战时序) | admission、TCP Lobby/Battle 与所属节点 `/start` |
| D11b | 所属节点结算授权 | [结算授权](./multiplayer-current.md#d11b-当前所属节点结算授权) | 事务外事实验证与本地 SQLite 结算 |

### 目标架构

| 编号 | 主题 | 文档 | 关注点 |
|---|---|---|---|
| D12 | 后台运营能力目标架构 | [后台运营能力 Gate](./admin-operations-gate.md) | 发布契约集中化、SQLite 公告、公共礼包码与邮件资源边界 |
| D13 | 拉芙觉醒任务与单人复活目标架构 | [觉醒任务与复活 Gate](./character-awake-and-continue-gate.md) | 拉芙任务 exact quest 与单人星导石复活协议；玛纳板独立性延期 |
| D14 | 统一角色成长状态服务（已落地，待实机验收） | [角色成长状态 Gate](./character-growth-state-gate.md) | Growth commands、事务、任务事实、投影、`/load`、存档与性能合同 |
| D15 | 全项目领域边界蓝图（识别完成，实施主线进行中） | [领域边界蓝图](./domain-boundary-blueprint.md) | CDN/客户端/服务端三层边界；owner、有限 shared core、adapter、projector 与独立模块 |
| D16 | Item Inventory Owner（已落地，Gate A 自动验证已完成） | [Item Inventory Owner Gate](./item-inventory-owner-gate.md) | typed Item Content、唯一 Item writer、cap 纯计划与 EventTrade 到期策略 |
| D17 | RewardGrant 正向协调核（已落地，Gate A 自动验证已完成） | [RewardGrant Core Gate](./reward-grant-core-gate.md) | 正向 Reward plan、资产 owner executors 与 Typed Grant Result；不成为 Economy bus |
| D18b | Item Overflow Disposition 与 Toast（服务端 Gate 已完成，实机统一延期） | [Item Overflow Disposition Gate](./item-overflow-disposition-gate.md) | `sellable` 驱动 Sold/Mail、Mana 二次 overflow 与官方 `data.over_max` Toast |
| D19 | Shop Purchase Owner（已实现） | [Shop Purchase Owner Gate](./shop-purchase-owner-gate.md) | 8 类真实 single、4/7 bulk、完整 Shop Content、统一 purchase plan/transaction owner 与局部索引 |
| D20 | Gacha Owner 与域内 Exchange（已实现，实机统一延期） | [Gacha Owner Gate](./gacha-owner-gate.md) | actual banner、draw payment plan与prize dispatch、typed campaign/rate、普通owner、域内exchange、Crazy、conversion与Gacha-local projector |
| D21 | Star Crumb Exchange 独立用例（已实现，实机统一延期） | [领域边界蓝图](./domain-boundary-blueprint.md) | typed 产品/成本 catalog、唯一事务 owner、Character/Item/Equipment 走 typed reward 执行与 D18b overflow disposition |
| D22 | Bond Token Exchange 独立用例（已实现，实机统一延期） | [领域边界蓝图](./domain-boundary-blueprint.md) | typed 产品/成本/库存/周期 catalog、list runtime（exchange_count）、唯一事务 owner 与 per-player 兑换计数 |
| D23 | Character Growth Writer Convergence（已实现，实机统一延期） | [角色成长状态 Gate](./character-growth-state-gate.md) | 信赖之证资格按客户端规则统一派生（板1=非突破上限+全节点、板2=全节点）、节点/EXP/注入 writer 同事务收敛、metadata/EX Boost/repair/admin 经 aggregate command 或声明 adapter、DEBT-T01/T02 关闭 |

## 阅读顺序

1. 先读 D1，确认客户端、管理后台、服务进程、Content Snapshot、SQLite 和资源供给的系统边界。
2. 再读 D2 与 D3，理解任务求值如何嵌入单人战斗的入场与结算事务。
3. 阅读 D4 与 D5，理解奖励写入和养成写入怎样复用领域状态，又保持各自的规划语义。
4. 按 D6、D7、D8、D8b、D9 理解身份、时间、load、存档恢复和进程生命周期。
5. 最后读 D10、D11a 与 D11b，理解多人联机与 Hub 的跨节点拓扑、建房开战和所属节点结算。

D12、D13 与 D14 已完成服务端实现和自动化 Gate，等待客户端实机验收。三份 Gate 文档保留设计依据，同时作为相应已落地边界的架构与验证证据；它们不取代上述当前架构总览的阅读顺序。

D15 已完成领域边界识别、决策和后续实施路线。D16、D17、D18、D18b 的服务端实现、Gate A broad closure、D18b scoped final review 和服务重启均已完成；D19、D20、D21 与 D22 的服务端实现与逐 checkpoint 审查已完成，大 Gate B 的 broad closure、整体终审与服务重启已在 D22 收口时执行；D23 的 Character 持久状态 writer 收敛、信赖之证客户端对齐修复与 DEBT-T01/T02 关闭已完成；D24-D28 尚未实施；客户端实测统一延期到 D28 后。阅读这些 Gate 时仍需区分当前已落地私服策略、官方未知语义和客户端实机验收。

## 统一图例

- 矩形表示进程、组件或稳定业务职责；圆柱表示持久化状态。
- 实线箭头表示当前存在的同步调用、控制流或数据流。
- 虚线箭头只表示当前实现中的异步发布、缓存失效或非持久化旁注，不表示未来设想。
- 箭头标签标注跨边界协议、事务关系或所有权变化；普通同进程调用不重复标注。
- `Content Snapshot` 表示冻结的只读内容定义；`SQLite` 表示玩家与业务状态，两者不合并。
- 游戏 HTTP 协议标为 `Base64(MsgPack)`；多人 TCP 标为 `NUL` 分帧的 Typepacker 数组。

## 现状与目标分离

- 本目录已收录的 D1-D11b 全部描述当前实现，图节标题统一带“当前”。
- D12、D13 与 D14 描述已落地、待客户端实机验收的 Gate 架构；其中的实施状态和证据路径可以用于解释当前实现，仍需与功能支持矩阵区分自动验证和人工验收。
- D15 描述经审查确认、但尚未实施的目标领域边界；其图和表不能替代 D1-D11b 的当前架构事实。
- D16、D18、D18b、D19、D20、D21 与 D22 已实现 typed Item policy、Inventory writer、Item cap、按 `sellable` 的 Sold/Mail disposition、Item expiry owner、`/load` EventTrade 到期转换、Mail claim、Shop Purchase owner、Gacha owner（普通 draw、域内 exchange、Crazy 生命周期、兑换点转换通知）、Star Crumb Exchange owner 与 Bond Token Exchange owner（产品/成本/库存/周期、list runtime 与兑换计数）；不得据此宣称这些私服策略已经被官服后端证实，D23–D28 仍未实施。
- 当前图不混入未来组件、迁移步骤或完成度信息；功能状态仍由 `docs/status/` 维护。
- 目标架构必须使用独立图和独立证据，不得用虚线叠加到当前图。

## 维护规则

- 每张图保持在约 12 个稳定主节点以内，细节放在图后的边界说明和精简证据表。
- 每条跨进程、跨协议、跨事务或跨权威状态的边都必须能由仓库相对路径反查。
- Mermaid 代码块是 tracked 真源；外部渲染工具只用于视觉检查。
- 架构变化时同步更新图、边界说明与证据路径。
- 图中不得写入真实部署或敏感运行信息。
