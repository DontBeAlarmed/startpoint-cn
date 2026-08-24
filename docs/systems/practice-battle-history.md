# 练习战履历

## 协议语义

CN 1.8.1 的 `/history/practice_battle` 返回 `history` 数组。每条记录包含 29 个字段，与无限演武战斗履历的队伍、装备、伤害、耗时和结果字段完全相同，但练习战不按活动 ID 分组。

客户端使用以下核心字段：

- `category_id=15`、`quest_id`：定位练习关卡；
- `clear_rank`：有值时显示评级，没有值时显示退出或失败状态；
- `score`、`total_damage`、`elapsed_time_ms`：显示本次结果；
- 三组角色、Sub、装备、装备等级、强化等级、魂珠和角色伤害：恢复详情弹窗；
- `create_time`：按客户端时间字符串显示记录日期。

字段结构以 `HistoryPracticeBattleRealRemote.as` 和 `HistoryPracticeBattleDummyRemote.as` 为依据，没有沿用空列表桩推测字段。

## 服务端实现

schema 13 新增 `players_practice_battle_history`：

- `(player_id, play_id)` 唯一，重复 finish 不会生成重复记录；
- 按 `id DESC` 返回玩家履历；
- 正常完成记录 `finish_kind=0` 和计算后的 `clear_rank`；
- 失败 finish 记录 `finish_kind=1`、`clear_rank=null`；
- 总伤害和三名主位伤害按所有 `statistics.zones` 累加；
- 装备等级与强化等级在结算时快照，不依赖之后的背包变化。

履历写入位于 `/single_battle_quest/finish` 的总事务内。发奖、任务事实、关卡进度或 active quest 清理任一步失败时，履历也回滚。查询路由校验 viewer session 和当前存档，不再向任意 viewer 返回空列表。

练习战和无限演武共用 29 字段的协议构造器，但使用独立表和独立查询，避免活动 ID、清理策略或后续保留数量互相耦合。

## 存档边界

`players_practice_battle_history` 登记在存档 V2 的 `events` 领域，导出、恢复和克隆均覆盖；克隆时自增 `id` 重新分配。该表在 schema 13 引入；当前 Server Bundle 目标数据版本为 18。

## 未覆盖边界

手动 `/single_battle_quest/abort` 请求只提供 `finish_kind` 和可选战斗统计，不提供权威 `elapsed_time_ms`；旧 active quest 也没有开始时间。当前不会用 `0` 伪造手动退出履历。

若以后需要补齐手动退出记录，应先为 active quest 增加可信开始时间并完成旧 active quest 迁移，再在 abort 事务中快照队伍和伤害。该缺口不影响正常完成或战斗失败后进入结算的履历。

## 验证范围

自动测试覆盖：

- 29 字段构造、跨 zone 伤害、装备快照和非法 category；
- 插入幂等、查询顺序和玩家隔离；
- Fastify 查询响应与非法 viewer；
- finish 总事务成功与回滚；
- schema 13 引入、schema 18 当前兼容、存档 V2 和 Server Bundle 数据版本契约。

CN 客户端仍需验证练习战履历列表、详情弹窗、失败记录显示以及重新登录后的持久化。
