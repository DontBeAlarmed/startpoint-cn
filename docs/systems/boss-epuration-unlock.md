# 歼灭者讨伐战最高难度解锁

> 当前状态：服务端回归通过，待客户端复测。

## 活动与关卡

- 活动：`200076`，类型 `boss_epuration`。
- 最高难度：`200076009`，女帝歼灭者，仅单人游玩。
- 房主前置：`200076002`、`200076005`、`200076006`，三关均仅多人游玩。

活动整体受主线 `11010003` 的系统开放条件约束。进入活动后，客户端显示 `200076009` 还要求以下条件全部成立：

1. 剧情关 `200076008` 已完成。
2. `200076002` 已完成，并且 `host_finished=true`。
3. `200076005` 已完成，并且 `host_finished=true`。
4. `200076006` 已完成，并且 `host_finished=true`。

后三关以成员身份通关只能满足普通完成状态，不能替代房主通关。

## 客户端判定

国服客户端从两个位置读取 `host_finished`：

- 战斗结算：`single_battle_quest/finish` 或 `multi_battle_quest/finish` 的 `data.host_finished`。
- 重新加载：load 响应的 `quest_progress[category][index].host_finished`。

字段缺失或为 `null` 时，客户端不会自行推断房主通关。客户端对该状态采用单调合并：历史 `true` 不会被后续成员通关的 `false` 覆盖。

主数据与客户端参考：

- `wf-assets-cn/orderedmap/quest/event/advent_event_quest.json`：`200076009` 的剧情前置、Quest Set 和 `host_clear`。
- `wf-assets-cn/orderedmap/quest/quest_set.json`：Quest Set `10000002` 包含 `002/005/006`。
- `wf-1.8.1-cn-decompiled/.../QuestConditionByQuestClear.as`：普通完成与房主完成的组合判断。
- `wf-1.8.1-cn-decompiled/.../BattleQuestFinishLoadingTask.as`：结算后写入 `is_host_cleared`。
- `wf-1.8.1-cn-decompiled/.../InitializeRealRemote.as`：load 解析 `host_finished`。

## 服务端实现

`players_quest_progress.host_finished` 使用可空整数保存三态：

- `NULL`：旧记录或该关不涉及房主状态。
- `0`：已通关，但未以房主身份完成。
- `1`：已以房主身份完成。

多人结算只信任服务端房间中的 `room.host_player_id`。客户端虽然会上报 `statistics.is_host`，但不作为授权依据；房间状态缺失时按非房主处理，避免成员伪造房主通关。

只有“挑战成功且当前玩家是房主”才把状态从 `false` 提升为 `true`；后续成员通关不会降级。结算响应返回合并后的当前状态，load 则从数据库序列化同一字段。

### 联机身份一致性

同一账号可以绑定多个玩家存档，联机链路必须始终使用该账号的当前默认存档。统一解析顺序为：

1. 通过 `viewer_id` 调用 `getSession` 得到账号。
2. 通过 `resolvePlayerIdSync` 选择账号当前默认存档；默认存档无效时才按既有规则回退。
3. 通过 `getPlayerSync` 读取玩家数据。

房间创建、TCP `cooperation_room` 握手、多人战斗 start/finish 均复用 `resolveMultiPlayerContext`。修复前，房间创建和握手直接使用账号玩家列表首项，而 start/finish 使用当前默认存档；当默认存档不是首项时，`room.host_player_id` 与结算 `playerId` 不同，真实房主也会被判为成员并写入 `host_finished=0`。

多人结算会记录不含账号、viewer token 或角色信息的诊断字段：`roomHostPlayerId`、`playerId`、`isRoomHost`，用于客户端复测时核对房主判断。

## 旧存档迁移

旧服务端在 Advent 多人成功结算中曾无条件返回 `host_finished=true`，但没有写入数据库。旧表首次增加该列时，将既有 category `7/8` 的已完成关卡补为 `host_finished=1`，保持升级前客户端已经观察到的状态。该回填只执行一次；之后导入或克隆存档中的 `NULL` 不会在下次启动时被改写。

## 客户端验收

使用同一账号包含多个存档、当前默认存档不是玩家列表首项的场景复测：

1. 确认主线 `11010003` 和剧情 `200076008` 已完成。
2. 仅以成员身份通关 `002/005/006`，确认 `009` 仍不显示。
3. 分别创建房间并以房主身份成功通关 `002/005/006`。
4. 核对结算日志中 `roomHostPlayerId` 与 `playerId` 相同，且 `isRoomHost=true`。
5. 返回活动页面，确认 `009` 立即显示且可进入。
6. 重启客户端或重新 load，确认 `009` 仍保持解锁。
