# 无限演武（ScoreAttackEvent）

## 协议结论

- 官方关卡 category 为 `27`；category `9` 是教程关卡，与无限演武无关。
- 开战、结算和放弃分别复用 `/single_battle_quest/start`、`/finish`、`/abort`。
- 结算专用字段为 `score_attack_event.main_character_ids` 和 `score_attack_event.reward_ids`；`reward_ids` 保存分数奖励行 ID，不是道具 ID。
- `/history/score_attack_event_battle` 不参与核心结算，当前保持空履历，等待完整协议依据。

## 主数据

`score_attack_event_quest` 的关键列为：folder `1`、名称 `4`、首通奖励 `6`、B/A/S/SS 分数 `52/53/54/55`、入场道具 `57/58/59`、体力 `71`、普通掉落组 `72`、推荐属性 `73`、玩家经验/角色经验/玛纳/经验池 `86/87/88/89`、战斗时限 `104`。

当前 CN 表共 123 个关卡，全部消耗 10 体力；首通奖励和普通掉落组均为 `None`，服务端不再生成虚构的 clear/S+ 奖励。外层本地关卡 ID 用于关联分数奖励表，不能与 folder ID 混用。

`score_attack_border_reward` 共 11,100 行。每行保存行 ID、event ID、本地 quest ID、分数线、reason ID 和最多 6 个 `GeneralRewardKind` 奖励槽。`16001` 是 reason ID，不是道具 ID。

## 结算规则

1. 从 category 27 进度读取旧最高分。
2. 只有新分数更高时，选择 `(旧最高分, 新最高分]` 内全部奖励档位。
3. 当前 CN 11,100 行主数据的奖励 kind 集合严格为 `{0}`，即道具；服务端聚合同 ID 道具后调用现有奖励 helper。
4. 使用 B/A/S/SS 阈值计算 C=1、B=2、A=3、S=4、SS=5。
5. category 27 的基础玩家字段、普通掉落、任务统计、角色经验、档位奖励、最高分/最高评级/最佳耗时和持久化 active quest 删除全部位于同一个 SQLite 事务；提交后再清理内存 active quest。
6. 同分或低分仍可更新更短耗时，但不会重复发放分数档奖励。

转换资产仍完整保留每行最多 6 个奖励槽。运行逻辑只支持当前 CN 资产实际出现的 `kind=0`；未来若主数据出现任何其他 kind，会明确拒绝、回滚整个结算并保留 active quest，不会根据其他奖励表猜测语义。

## 客户端测试

- 开始任意无限演武关卡后体力减少 10。
- 首次高分跨越多档时，所有档位奖励到账，结算卡与奖励动画显示。
- 使用相同或更低分数再次结算，不重复获得奖励。
- 提高最高分时只补发新增区间内的档位。
- 结算响应显示本次主位角色；重新 load 后最高分和最高评级保持。

当前状态：服务端专项测试通过，客户端待重新验收。履历页面不属于本轮范围。

服务端事务回归使用真实 Fastify `/finish` 与内存 SQLite：先允许 progress 正常写入，再由 `players_active_quests` 的 `AFTER DELETE` trigger 在删除阶段抛错，确认玩家字段、角色经验、任务统计、档位奖励、progress 和 DB active 全部回滚且内存 active 保留；移除 trigger 后以同一请求重试，所有奖励与计数只写入一次。
