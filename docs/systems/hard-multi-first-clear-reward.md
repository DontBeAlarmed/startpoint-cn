# Hard Multi 首通奖励

## 数据来源

Hard Multi 的运行时表为 `assets/hard_multi_event_quest.json`，由
`scripts/converter.py` 注册的 `convert_hard_multi_event_quest` 生成。输入是国服
1.8.1 CDN 的 `quest/event/hard_multi_event_quest.json`。

字段位置以 CN 1.8.1 客户端生成类
`HardMultiEventQuestValues.as` 为准：

| CDN 列 | 含义 | 运行时字段 |
|---:|---|---|
| `row[2]` | 关卡名称 | `name` |
| `row[4]` | `first_time_clear_reward_id` | `clearRewardId` |
| `row[16]` | `viewable_need_quest_2_multiplied_id` | 不属于奖励字段 |
| `row[72]` | `s_plus_clear_reward_id` | `sPlusRewardId` |
| `row[85..88]` | B/A/S/S+ 时间（秒） | 对应毫秒字段 |
| `row[94]` | 排名点 | `rankPointReward` |
| `row[95]` | 角色经验 | `characterExpReward` |
| `row[96]` | 玛娜 | `manaReward` |
| `row[97]` | 经验池 | `poolExpReward` |

因此 `100002001` 的首通奖励是 `34`，不是同一行 `row[16]` 的
`200077004`。奖励 `34` 在 `assets/clear_reward.json` 中定义为 30 个星导石。

## 生成与审计

重新从官方 CDN 生成 Hard Multi 资产时，调用现有转换器入口：

```text
scripts/converter.py
  -> convert_hard_multi_event_quest
  -> assets/hard_multi_event_quest.json
```

`tools/hard_multi_event_quest.test.cjs` 同时检查原始列映射、转换器与 12 条 bundled
关卡完全一致，以及所有已接入关卡表的 `clearRewardId`/`sPlusRewardId` 外键。奖励表
不存在的引用不应进入运行资产。

## 首通结算约束

首通奖励的发放条件是：

```text
本次 questAccomplished === true
且历史进度不存在 finished === true
```

历史进度行已经存在但 `finished=false` 时，仍视为未首通；本次成功会更新该行并发放
首通奖励。重复成功只更新最佳成绩、评级等字段，不重复发首通奖励。

缺失的首通或 S+ 奖励不会被当作空奖励跳过，也不会把 `null` 传入发奖函数。
按 category 读取关卡时，服务端会在进入结算事务前抛出包含 category、quest ID、奖励
ID 和字段名的配置错误；事务因此不会写入部分玩家状态。该错误表示内容表或转换结果
非法，应修复 CDN 提取/运行资产后再重试。

单人和联机结算共用首通判定；关卡进度“是否有行”与“是否已完成”是两个不同状态，
不能再用前者代替后者。
