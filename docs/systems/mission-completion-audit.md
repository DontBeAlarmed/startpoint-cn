# 任务系统完成度审计

## 已修复项目

- 分类任务进度使用 `players_category_missions`，以 `(category, mission_id, player_id)` 唯一标识。
  普通、每日、活动、每周和觉醒任务即使 ID 相同也不会互相覆盖。
- 数据库版本 3 会把已知角色觉醒记录从旧 ActiveMission 表迁出；无法确定分类的历史行不会猜测迁移。
- 进度写入使用 SQLite UPSERT，不再通过 `INSERT OR REPLACE` 删除已有的阶段领奖子记录。
- `update_mission_progress` 把客户端值作为增量处理，符合 `MissionCounterLogic` 每次静默上报后清空本地批次的行为。
- 每日和每周重置只删除 category 2 与 category 10 的数据；category 10 使用 `RegularComputer` 和每周快照。
- 阶段阈值读取 CN 各表的正确列：普通/每日/活动/称号/每周为第 1 列，收集任务为第 2 列，觉醒任务为第 5 列。
- `get_mission_progress` 会检查任务开放时间、收集任务 `event_id`，并独立处理每个角色觉醒
  `character_id` 请求。
- 普通分类的 `get_mission_progress` 保持只读；携带角色 ID 的 category 9 请求是觉醒第一页的正式领奖入口，
  会原子结算已完成且未领取的阶段。
- ActiveMission 领奖会在原子发奖前校验任务存在、阶段定义、完成阈值、既有领奖状态与重复请求。
- ActiveMission 奖励保留 kind 0（星导石），并把物品、装备、角色、玛纳、经验和称号写入正确的响应集合。

## 角色觉醒时序

角色觉醒的“第二页解锁”和“第一页领奖”已经解耦：

- 权威状态变更端点在最终条件成立时幂等写入 `players_character_awake_unlocks`，并仅在状态真正变化时通过
  `character_list` 发布；该步骤不写 category 9 领奖状态，也不发奖。
- 因持久解锁会在场景创建前进入客户端角色状态，全部任务完成的角色首次进入时直接显示第二页。
- 玩家手动切回第一页后，category 9 `get_mission_progress` 才结算所有未领奖励，返回
  `mission_info` 和奖励变更，不重复发布已有解锁。
- 对缺少持久解锁且最终特殊阶段仍未领奖的旧/异常存档，该阶段结算会幂等补写；只有本次 UPSERT
  改变状态时才返回一次角色解锁条目。
- 如果最终特殊阶段已经存在领奖状态但解锁行丢失，结算逻辑不会重放；由 `/load` 校准或数据库升级回填修复。
- 结算逻辑会先按 `mission_id` 聚合最大进度，再统一持久化和领奖，重复输入不会让进度回退。
- 结算涉及的进度、领奖状态、普通奖励、持久解锁和玩家数据处于同一 SQLite 事务，任一步骤失败都会整体回滚。
- 重复进入、重复领奖请求与重复校准都不会重复发奖、重复通知或降低解锁等级。
- `/load` 从持久解锁重建 `mana_board_awake`，并与实际节点觉醒等级按板取最大值。

客户端 `preparation()`、`afterTransition()` 和 `tabChanged(1)` 的详细行为见
`character-awake-refresh.md`。

## 尚未完成的功能

- PassDaily、PassWeek、PassEvent（category 6、7、8）在客户端枚举中存在，但尚未取得对应服务端阶段与奖励主数据，
  当前仍不返回任务行。
- 并非所有可能改变服务端计算进度的玩法端点都已接入通用分类任务奖励结算。角色觉醒按客户端约定单独在
  category 9 页面入口领奖。
- 重复通关型活动任务需要按活动保存历史重复次数；当前 quest progress 能统计不同已完成关卡和已保存的共斗次数，
  不能完整还原所有单人历史重复通关。
- 角色觉醒的配对、竞速进度仍依赖已记录的本地计数器与映射；奖励结算与最终特殊奖励触发已按
  CN 1.8.1 主数据实现。

因此，虽然分类隔离存储、重置、协议过滤、ActiveMission 领奖安全以及角色觉醒时序已经修复，
两个 mission 进度端点的整体状态仍标记为部分完成。
