# 特殊关卡架构审计

> 客户端验收状态：未测试。无限激战、土俑、战阵统一列入下一阶段测试目标。

## 结论

无限激战（Rush）、土俑（Carnival）和战阵（Raid）的 HTTP 入口已经分开，结算中的模式特有逻辑也分别位于 `src/lib/quest/finish/*-handler.ts`。目前属于“流程可独立运行，但状态与通用结算仍有耦合”，还不是完全插件化的关卡架构。

## 当前边界

| 层 | Rush | Carnival | Raid | 评价 |
|---|---|---|---|---|
| 路由 | `rushEvent.ts` | `carnivalEvent.ts` | `raidEvent.ts` | 独立 |
| 主数据 | `rush_event_quest.json` | `carnival_event_quest.json` | `raid_event_quest.json` | 独立 |
| 特有结算 | `rush-handler.ts` | `carnival-handler.ts` | `raid-handler.ts` | 独立 |
| 队伍 | `PartyCategory.RUSH`（4） | `PartyCategory.CARNIVAL`（2） | `PartyCategory.RAID`（3） | 已按客户端协议隔离，待验收 |
| 玩家状态 | Rush 表 | Carnival 专用表 | 复用 Rush played-party 表 | Raid 与 Rush 耦合 |
| 通用结算 | `singleBattleQuest.ts` | `singleBattleQuest.ts` | `singleBattleQuest.ts` | 共享且体积较大 |

## 已确认风险

1. 三种模式的配队分类已按国服客户端协议拆分为 Carnival=2、Raid=3、Rush=4。服务端曾把 Raid 的 3 强制映射为 4，并让 Carnival/Raid/Rush 路由都读取 4；Rush 还曾对 12 个组重复返回槽位 ID `1..10`。分类与全局 ID 冲突均已修复，待客户端验收。
2. Raid 使用 `players_rush_events_played_parties` 和 `RushEventBattleType.FOLDER` 保存出战队伍。字段目前足够，但命名、生命周期和未来迁移都与 Rush 绑定。
3. 单人和多人结算分别实现了经验、Mana、进度、奖励和统计更新。两条路径已经出现字段取值差异，后续新增关卡规则需要改两处。
4. `getQuestFromCategorySync()` 是集中式 category switch。新增模式必须同时修改资源加载、路由注册、开始和结算分派。
5. 特有 handler 通过大量函数参数注入数据库操作，测试方便，但缺少统一的 `start/finish/abort/serialize` 模式契约。

## 建议演进顺序

1. 先抽取共享 `QuestFinishService`，让 single/multi 共用奖励、角色经验、关卡进度和统计更新事务。
2. 定义轻量 `QuestModeHandler`：`validateStart`、`onStart`、`onFinish`、`onAbort`、`buildResponse`。按 category 注册，不一次性重写现有路由。
3. 为 Raid 建立专用 played-party domain/table；保留兼容读取迁移，避免直接改旧数据。
4. 继续使用客户端原生 `party_category`，不要新增服务端私有分类。历史 `category=4` 数据只在目标分类缺失时用于补齐；目标分类已有记录始终优先，避免兼容迁移覆盖玩家新配队。
5. 最后把资源转换器的字段契约加入生成测试，防止 CDN 列偏移再次进入运行资产。

## 本轮已修正的数据/流程

- Carnival 分数使用主数据第 104 列的真实 `difficulty_score`。
- Carnival 第 100 列 `battle_time_limit` 按客户端逻辑从 60 FPS 帧数换算为毫秒；禁止直接作为毫秒使用。
- Carnival 累计分奖励使用独立主数据和领取表，在事务中完成最佳分更新、奖励发放和领取登记。
- Raid 修正列偏移，并在结算返回客户端必需的 `raid_event`。
- Rush/Raid 失败结算不再推进模式进度。
- Rush endless 下一轮按 round 排序。
- 特殊关卡配队按 Carnival=2、Raid=3、Rush=4 独立保存和读取；配队组颜色使用请求分类更新并在页面重载时返回持久化值。
- Rush 的 12 组队伍统一使用全局 `party_id=1..120`；禁止把每组内部槽位 `1..10` 直接作为响应 ID。
- Advent 多人结算按真实房主身份持久化 `host_finished`，并在 load 恢复；歼灭者最高难度不新增服务端私有解锁规则，继续由客户端按原生 Quest Set 条件判断。
- 配队及配队组编辑端点只接受整数分类 1 至 4，避免创建客户端无法访问的协议外数据。
- 历史 `category=4` 配队按“目标分类 > 历史数据 > 默认队伍”的顺序补齐，使用只插入缺失记录的方式保留现有数据。
- Carnival 171 行、Raid 50 行运行资产均完成字段完整性检查。

以上属于代码和资产检查结果，不代表客户端进入、配队和结算已经验收通过。
