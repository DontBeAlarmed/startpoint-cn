# 角色觉醒页面刷新与解锁时序

## 客户端行为

CN 1.8.1 客户端在 `CharacterAwakeScene.preparation()` 中读取并缓存
`mana_board_awake[1]`：

- 缓存值为 `0` 时，场景默认进入第一页并禁用第二页；
- 缓存值大于 `0` 时，场景默认进入第二页，并将该值作为目标觉醒等级。

`afterTransition()` 会根据初始页签决定是否请求任务。未解锁角色进入第一页后，客户端自动通过
`MissionGetProgressProcessingFlow` 请求 category 9 的
`mission/get_mission_progress`；已经解锁、直接进入第二页时不会自动请求任务。

玩家之后手动切回第一页时，`tabChanged(1)` 会在当前场景尚未请求过任务列表的前提下发起同一请求。
该处理流只刷新任务列表，不会重新计算场景已缓存的 `boardAwakeLevel`，也不会在当前场景内动态启用第二页。

所有 API 响应都可以携带公共字段 `character_list`。`RealRemoteService` 会先处理公共响应，
`PlayerLogic.applyCommonResponseCharacterList()` 再把 `mana_board_awake` 写入客户端持有的角色状态，
之后才进入端点自己的处理流。

## 服务端最终流程

觉醒板解锁与任务奖励领取是两份独立的持久状态：

- `players_character_awake_unlocks` 保存第二页的持久解锁；
- `players_category_mission_stages.status` 保存 category 9 各阶段是否已经领奖。

### 任务尚未全部完成

1. 角色没有持久解锁，首次进入默认显示第一页，第二页保持禁用。
2. `afterTransition()` 自动请求 category 9 的 `get_mission_progress`。
3. 服务端结算当前已经完成且尚未领取的阶段，返回 `mission_info`、奖励变更集合和任务进度。
4. 因最终特殊阶段尚未完成，响应不会解锁第二页。

### 任务已经全部完成

1. 使最终条件成立的权威状态变更端点会先计算觉醒任务，并幂等写入持久解锁。
2. 只有该次写入确实新建或提高了解锁等级时，端点才通过
   `character_list.mana_board_awake` 发布角色变化。
3. 此过程不写领奖状态，也不发放普通奖励；category 9 的奖励仍全部保持未领取。
4. 客户端第一次进入觉醒场景时已经持有正数解锁等级，因此直接显示第二页。
5. 玩家手动切回第一页后，`tabChanged(1)` 发起 `get_mission_progress`，服务端一次结算全部未领奖励并返回
   `mission_info`，但不会再次发布已经存在的解锁条目。
6. 重复切换页签、重复请求或再次进入都不会重复发奖，也不会重复返回 `mission_info`。

`mission/update_mission_progress` 只累计客户端上报的任务增量，不执行奖励结算，也不调用
`computeAwakeSummary`。写入进度后它会调用 `reconcileAwakeUnlockCharacterList`，因此若该权威增量刚好完成最终条件，
可以在同一响应中发布新的持久解锁。

其他会改变权威进度的战斗、剧情、信赖证、邮件、出售与商店端点也会在状态落库后执行校准。
`/load` 会对持有角色执行同样的持久化校准，并把持久解锁与已经觉醒的节点等级按每块板的最大值合并序列化。

## 最终特殊阶段未领奖时的恢复路径

旧存档或异常存档可能已经完成最终特殊阶段、该阶段仍未领奖，却缺少
`players_character_awake_unlocks` 行。category 9 结算在首次处理这个未领奖的
`AwakeManaBoard` 特殊阶段时，会在同一事务内执行幂等 UPSERT：

- UPSERT 本次改变状态时，写入持久解锁，并在 `character_list` 中发布一次；
- 持久解锁已存在且等级不低时，只处理领奖状态、普通奖励和 `mission_info`，不重复发布角色条目；
- 领奖状态已存在时，重复结算不再发奖、不再返回 `mission_info`，也不再发布解锁。

如果最终特殊阶段已经存在领奖状态，但持久解锁行后来丢失，结算逻辑会按幂等规则跳过该阶段，
不会再次执行特殊奖励或重发角色条目。此类存档由 `/load` 的觉醒任务校准修复；数据库版本升级时，
也会通过已领取的 `AwakeManaBoard` 阶段执行回填。

正常流程不再要求玩家退出后重进才能解锁第二页：最终权威端点会在场景创建前把解锁发送给客户端。
只有最终端点响应丢失、客户端仍持有旧缓存这类异常情况，当前已创建场景才无法原地启用第二页。
可靠的客户端恢复方式是重新执行 `/load`，通常通过重新登录触发；单纯再次进入觉醒场景不保证刷新角色缓存。

## 服务端校验

`/character/awake_mana_node` 使用持久解锁校验请求，不依赖 category 9 是否已经领奖。
请求还必须满足目标等级一致、基础板全部学习、请求节点均属于板 1、节点列表非空且无重复等条件。
玛纳、物品与节点觉醒等级在同一个 SQLite 事务中提交。
