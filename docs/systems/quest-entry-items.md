# 关卡门票消耗

> 当前状态：门票主数据、start 预扣、abort 返还和未完成关卡恢复均已实现；待客户端验收。

## 官方语义

国服关卡门票分为两种模式：

- `Always`：每次挑战都需要门票。正式服在 start 成功时先预扣并返回扣后的 `item_list`，成功 finish 后确认消费；失败或主动 abort 时返还。
- `Once`：通过 `/quest/unlock` 消耗一次并永久解锁，后续挑战不再消耗该门票。

国服客户端确认框文案为“使用的道具将在通关后被扣除”。正式服宝物域抓包同时显示 start 响应已经返回减少后的钥匙数量，因此服务端需要采用“预扣后按结果确认或返还”，不能只在 finish 时才校验库存，也不能在 abort 后永久保留扣除。

## Always 关卡

| 类型 | 关卡 | 门票 | 数量 | 体力 |
|---|---|---:|---:|---:|
| Advent 最高难度 | `200013009` | `40314` | 1 | 30 |
| Advent 最高难度 | `200021009` | `40323` | 1 | 30 |
| Advent 最高难度 | `200050009` | `40335` | 1 | 30 |
| Advent 最高难度 | `200071009` | `10000049` | 1 | 30 |
| 歼灭者最高难度 | `200076009` | `10000072` | 1 | 30 |
| 挑战迷宫 | `1038`～`1040` | `30029` | 1 | 0 |
| 宝物域 | `2001`～`2006` | `500000` | 1 | 10 |

Advent 字段来自原始行 `61/62/63/75`，挑战迷宫与宝物域字段来自 `56/57/58/70`。

此前生成器存在两个问题：

1. Advent 没有配置门票列，5 个最高难度被生成成 `itemId=0`、`itemCount=0`。
2. 生成条件只接受体力大于 0，导致 `1038`～`1040` 三个纯门票关完全缺失。

Content Sync 现在直接从 20 张官方关卡表生成入口记录：只要关卡具有正体力成本或 `Always` 门票成本就会进入 `quest_entry_costs.json`。当前 Release 共 3045 条成本，其中 14 条含 Always 道具成本。回归测试逐条对比国服原始表，避免列索引或零体力过滤再次造成免费入场。

## 预扣生命周期

`Always` 门票按以下生命周期处理：

1. `/single_battle_quest/start` 在一个 SQLite 事务中校验门票和体力、预扣门票、扣除体力并保存 active quest。事务失败时全部回滚，内存中也不会发布 active quest。
2. active quest 同时持久化 `entry_item_id` 和 `entry_item_count`。旧数据库会自动增加数量列；迁移前遗留的 `entry_item_count=NULL` 只在当前 `category + quest_id` 的门票 ID 一致且数量恰好为 1 时回退。这是一条一次性兼容规则，未来若出现一次消耗多张门票的关卡，服务端不会猜测并返还数量。
3. `/single_battle_quest/abort` 在一个事务中读取 active quest，并同时核对请求的 `play_id/quest_id/category`。三项全部匹配才返还门票并删除 active；旧 abort 延迟到达且当前已有新战斗时，服务端返回成功和空 `item_list`，但不会修改数据库或清除内存。正常提交后才清除内存记录，重复 abort 也不会重复返还。
4. abort 不返还体力。`/play_continue` 只处理续关费用和次数，并按客户端提交的复活前 count 幂等结算；详细规则见下节。成功 finish 保留 start 的门票扣除，不再扣除第二次，也不返还。
5. CN `/load` 会把有效的持久化 active quest 重新发布到内存，因此服务重启后仍可继续、完成或放弃。多人房间已失效时，load 会先执行同一取消事务再序列化背包，不再直接删除记录。

abort 路由显式返回 `application/x-msgpack`，由 CN 服务的 `onSend` hook 执行 MsgPack 打包和 Base64 编码。active quest 的 registry、持久化与取消事务位于独立 service，load 和各战斗路由不再互相导入。

多人战斗同样读取当前 Content snapshot 的 `quest_entry_costs`，但入场成本只由房主承担：房主 start 在一个事务内预扣体力和 Always 门票、保存 `entry_item_id/count` 与 active quest；成员 start 以零成本保存各自的 active quest。事务提交后才更新内存 active quest 和房间战斗状态，因此扣除或写库失败不会把房间提前卡进战斗态。房主 abort 按同一规则返还门票但不返体力，成员没有入场道具可返还。

## 单人付费复活幂等

单人 `/play_continue` 固定接受 `payment_type=1`，并要求 `statistics.continue_count` 是非负安全整数。该值是客户端发起复活前观察到的次数，不使用 `api_count` 充当幂等键。缺失、负数、小数、字符串或超出安全整数范围的 count 会在任何持久写入前返回 400。

服务端在同一个 SQLite 事务内重新读取玩家余额和 active quest，并始终核对内存及 SQLite 中的 `play_id/quest_id/category` 与单人身份。SQLite 的 `continue_count` 是权威值：

- 权威值等于请求值时，这是首次结算。服务端先扣免费星导石，不足部分再扣付费星导石，然后把权威值安全地加一；当前值已经是 `Number.MAX_SAFE_INTEGER` 时拒绝，不能产生不安全整数。
- 权威值等于请求值加一时，这是成功响应丢失后的原请求重放。服务端返回当前数据库余额，把内存 active quest 同步到权威 count，但不写数据库、不重复扣费。该判断只依赖当前 SQLite 状态，因此服务重启并由 `/load` 恢复 active quest 后仍可重放。
- 其他差值均视为 stale 或 future 请求，返回 400 且不写入。

事务抛错时余额与 count 一起回滚，内存 count 只在事务成功返回后更新。这里的幂等范围只覆盖同一场单人战斗中的付费复活；自动连战由客户端结果页重新调用 `/start` 建立下一场战斗，不复用 `/play_continue`，也不在本规则中实现 `battle_max_continue_count`。

## finish 事务边界

单人 finish 已把通用奖励、活动专用结算、进度、任务事实和数据库 active quest 删除纳入同一个外层 SQLite
事务。任一持久写入失败时全部回滚，数据库与内存 active quest 都保留，客户端可以使用原请求重试；只有事务
提交成功后才清除进程内 active quest。成功 finish 保留 start 阶段已经预扣的 `Always` 门票，不会重复扣除或
返还。完整范围与回归约束见[战斗关卡结算事务](./quest-finish-transactions.md)。

## Once 关卡

9 个外传关卡 `400001102`～`400009102` 使用 `60001 ×1` 解锁。它们不进入 start 的每次预扣逻辑，由 `/quest/unlock` 独立处理；没有权威 Once 成本的普通关卡会被拒绝，不允许借此免费设置 `unlocked=true`。解锁路由在事务内重新读取进度和库存，先聚合同一道具的全部成本并完整校验，再扣除材料和写入永久解锁状态；任一写入失败都不会留下“材料已扣但关卡未解锁”的半完成状态。`quest_unlock_costs.json` 与关卡表在同一 Content Release 中生成；历史 bundled 还包含 6 条 `1001`～`1006`，实际来源是 Daily 表的普通奖励组而非 Once 模式，现已从动态结果删除。

仓库内同名 `assets/*.json` 只用于 Content snapshot 尚未初始化的低级测试和无 Release 兼容启动；正常服务初始化后，start、abort、load、unlock 和体力计算统一读取当前 snapshot，Release 缺表或损坏时不会静默回退旧门票数据。
