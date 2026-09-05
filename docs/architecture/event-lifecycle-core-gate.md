# D26 Event Lifecycle 有限核

状态：typed descriptor、有限 built-in hook 与 Single Event adapter 已实现；等待 D26/Gate C final review、唯一 broad 和服务重启。当前服务端坚持 official-only；已登记的体验优化必须独立标识。

## 有限共享边界

`event-settlement-descriptor.ts` 从已经选择并验证的 BattleQuest、quest category/ID 和 active event identity 构造 `none|rush|raid|carnival|scoreAttack` descriptor。descriptor 只携带：

- quest/event linkage；
- Rush folder/round；
- Raid kill weight；
- Carnival folder、difficulty、time limit；
- ScoreAttack event/quest linkage；
- 原关卡的只读 availability window。

descriptor 不读 DB/Content/网络，不拥有玩家状态。window 不会在 finish 时重新拒绝已经入场的战斗，因此不改变跨过活动结束时点的现有结算语义。

`event-settlement-hook.ts` 对一个闭合 descriptor 最多调用一个 built-in hook；`none` 不调用。它不是万能 Event 状态机，也不合并 handler 的输入、状态或结果结构。

## 模式独立性

| 模式 | 独立 owner |
|---|---|
| Rush | folder/round、played parties、endless、folder reward、reset/shop/ranking |
| Raid | global boss HP/kill、quest kill、Raid parties、overall reward |
| Carnival | folder best score、total score、threshold reward、played party |
| ScoreAttack | score rank、history、border reward、专用 response |

`single-event-settlement.ts` 只负责把 descriptor 分派到上述 handler，并组装各自已有的依赖；外层 SQLite 事务仍由 Single finish 掌握。Practice history不是 built-in Event，继续留在 Single adapter。

## Operator mode seam

`modes.d` 是显式安装、allowlist 和重启生效的运营扩展 seam，不是官方协议来源。`dispatchModeRushFinish` 继续收到原完整 questData，并与 built-in descriptor 分派分离；空 `modes.d` 是官方服务默认形态。私有 `700099` 深渊玩法及其掉落、商店、排行榜和 endless 兼容不进入当前代码或 D26 证据。

## 已知 Rush AutoRetry 差异

CN 客户端只有在有限 folder final 响应含非空 `rush_battle_reward_list` 时才打开 clear dialog 并触发下一 lap AutoRetry。当前首次 clear 满足，重复 clear 因一次性奖励返回空列表，不进入该路径。

该结论只能证明当前响应和客户端跳转条件之间的差异，不能证明官服后端每 lap 的奖励频率。D26 不根据私有实现改写奖励经济，也不返回假奖励；`rush_event_battle_flow.test.cjs` 以真实 Fastify + SQLite 两-lap 链将它固定为待客户端专项验收的已知差异。

常驻官方末期 Rush `700011–700017` 的静态奖励/商店为空，当前已有 `eventId-10` 推测性体验回退。该行为不是 D26 shared core；用户确认未来开关默认开启，但必须由后台原子控制 folder reward、shop list 与 purchase period。开关化在边界重构后的独立策略任务执行。

## 性能与测试

- descriptor 纯解析 O(1)，无全活动扫描；
- 一个 finish 最多调用一个 built-in mode handler；
- integration:event 保留每种 actual mode、route、state、reward 与 rollback 代表；
- quick:modes 保留 loader、allowlist、lifecycle 与事务回滚；
- Single settlement baseline 保持行为与 SQL 快照不变；
- D26 closure 前不删除各模式状态/算法/transport tests。
