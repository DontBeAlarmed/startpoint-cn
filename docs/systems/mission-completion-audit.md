# 任务系统完成度审计

## 已完成基础

- 分类任务进度使用 `players_category_missions`，以 `(category, mission_id, player_id)` 唯一标识。
  普通、每日、活动、每周和觉醒任务即使 ID 相同也不会互相覆盖。
- 数据库版本 3 会把已知角色觉醒记录从旧 ActiveMission 表迁出；无法确定分类的历史行不会猜测迁移。
- 进度写入使用 SQLite UPSERT，不再通过 `INSERT OR REPLACE` 删除已有的阶段领奖子记录。
- `update_mission_progress` 把客户端值作为增量处理，符合 `MissionCounterLogic` 每次静默上报后清空本地批次的行为。
- 每日和每周重置只删除 category 2 与 category 10 的数据；category 10 已有每周快照与重置基础设施。
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
[角色觉醒刷新与解锁时序](./character-awake-refresh.md)。

## 已确认的正确性缺口

- `update_mission_progress` 当前统一从 `row[0]` 读取 pattern，但 Collect-item、Degree 和 CharacterAwake 的 pattern 不在同一列；不同 category 必须按 CN 主数据结构解析。
- 客户端 pattern 增量更新没有完整限制到当前开放期、category 和 event，可能污染历史或未来的同名任务。
- 单人战斗的部分角色觉醒 tracker 尚未统一受成功结算约束，失败战斗仍可能累计部分条件。
- category 10 虽然注册到 Regular 计算器，但计算器的任务扫描范围尚未完整覆盖周常。
- 角色觉醒仍有明确条件错误：配对计数排序不一致、`2310012` 种族组合错误、`3310032/3310033` 缺少指定关卡约束，以及空羁绊数组误完成风险。

## 尚未完成的分类

- PassDaily、PassWeek、PassEvent（category 6、7、8）在客户端枚举中存在，但尚未取得对应服务端阶段与奖励主数据，
  当前仍不返回任务行。
- category 1、2、3、4、5、10 尚无完整通用自动结算链。普通任务没有独立的客户端手动领奖端点，最终需要由业务响应统一发布 `mission_info`、奖励和阶段状态。角色觉醒按客户端约定单独在 category 9 页面入口领奖。
- Collect-item 尚未形成完整库存或累计获得量模型；Degree 仅覆盖少量等级条件；`/load` 的收集任务清单仍不完整。
- 重复通关型活动任务需要按活动保存历史重复次数；当前 quest progress 能统计不同已完成关卡和已保存的共斗次数，
  不能完整还原所有单人历史重复通关。
- 角色觉醒的配对、竞速进度仍依赖已记录的本地计数器与映射；奖励结算与最终特殊奖励触发已按
  CN 1.8.1 主数据实现。

因此，分类隔离存储、重置基础、ActiveMission 领奖安全以及角色觉醒核心时序已经具备，但任务模块整体仍是部分完成。下一阶段应先修复 pattern、开放范围和成功结算约束，再扩展通用自动结算与 Pass。
