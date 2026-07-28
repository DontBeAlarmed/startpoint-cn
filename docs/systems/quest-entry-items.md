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
4. abort 不返还体力。`/play_continue` 只处理续关费用和次数。续关请求必须与内存及 SQLite 中的 `play_id/quest_id/category` 同时一致；事务内重新读取余额，先扣免费星导石，不足部分再扣付费星导石，并同步持久化 continue count，提交成功后才更新内存 active quest。成功 finish 保留 start 的门票扣除，不再扣除第二次，也不返还。
5. CN `/load` 会把有效的持久化 active quest 重新发布到内存，因此服务重启后仍可继续、完成或放弃。多人房间已失效时，load 会先执行同一取消事务再序列化背包，不再直接删除记录。

abort 路由显式返回 `application/x-msgpack`，由 CN 服务的 `onSend` hook 执行 MsgPack 打包和 Base64 编码。active quest 的 registry、持久化与取消事务位于独立 service，load 和各战斗路由不再互相导入。

多人战斗 start 当前不读取 `quest_entry_costs`，也不会写入 `entry_item_id/count`，因此正常多人 abort 没有门票可返还；失效房间清理仍统一走取消事务，以兼容可能存在的历史或异常记录。

## 剩余风险

单人 finish 仍沿用原有顺序：先删除 active quest，再执行较长的奖励与进度写入流程。若删除后发生异常，战斗不能通过 active quest 重试。此次没有将整个 finish 纳入总事务，避免在缺少完整幂等设计时引入重复奖励；后续应作为独立结算原子化模块处理。

## Once 关卡

9 个外传关卡 `400001102`～`400009102` 使用 `60001 ×1` 解锁。它们不进入 start 的每次预扣逻辑，由 `/quest/unlock` 独立处理；没有权威 Once 成本的普通关卡会被拒绝，不允许借此免费设置 `unlocked=true`。解锁路由在事务内重新读取进度和库存，先聚合同一道具的全部成本并完整校验，再扣除材料和写入永久解锁状态；任一写入失败都不会留下“材料已扣但关卡未解锁”的半完成状态。`quest_unlock_costs.json` 与关卡表在同一 Content Release 中生成；历史 bundled 还包含 6 条 `1001`～`1006`，实际来源是 Daily 表的普通奖励组而非 Once 模式，现已从动态结果删除。

仓库内同名 `assets/*.json` 只用于 Content snapshot 尚未初始化的低级测试和无 Release 兼容启动；正常服务初始化后，start、abort、load、unlock 和体力计算统一读取当前 snapshot，Release 缺表或损坏时不会静默回退旧门票数据。
