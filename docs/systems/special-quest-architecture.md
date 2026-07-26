# 特殊关卡架构审计

> 客户端验收状态：土俑已通过；狂热激战、战阵和无限演武按各自清单继续测试。

## 结论

狂热激战（Rush）、土俑（Carnival）、战阵（Raid）和无限演武（ScoreAttackEvent）的主数据与模式状态已经分开。四种模式的特有结算分别位于 `src/lib/quest/finish/*-handler.ts`；战阵由客户端作为本地三队 Raid 启动，不属于常规多人房间。目前属于“模式逻辑可独立测试，但仍共享通用结算路由”，还不是完全插件化的关卡架构。

## 战阵协议语义

国服客户端对 Quest Category 23 固定进入 `SingleQuestStartFlow`，配队使用 `RaidEventPartySelectLogic`，战斗进入 `RaidBattleStart`。玩家操作自己的三支队伍，流程不会创建、搜索或加入 `multi_battle_quest` 房间。

因此 Raid 的验收范围是三队配队、`event/raid/battle/start`、战斗和结算。多人 HTTP/TCP 房间实现不属于战阵流程，也不应把缺少常规共斗入口记录为 Raid 缺陷。

## 当前边界

| 层 | Rush | Carnival | Raid | ScoreAttackEvent | 评价 |
|---|---|---|---|---|---|
| 路由 | `rushEvent.ts` | `carnivalEvent.ts` | `raidEvent.ts` | 通用单人路由 | 前三者有独立入口 |
| 主数据 | `rush_event_quest.json` | `carnival_event_quest.json` | `raid_event_quest.json` | `score_attack_event_quest.json` | 独立 |
| 特有结算 | `rush-handler.ts` | `carnival-handler.ts` | `raid-handler.ts` | `score-attack-handler.ts` | 独立 |
| 队伍 | `PartyCategory.RUSH`（4） | `PartyCategory.CARNIVAL`（2） | `PartyCategory.RAID`（3） | 普通单人队伍 | 按客户端协议 |
| 玩家状态 | Rush 表 | Carnival 专用表 | 复用 Rush played-party 表 | category 27 关卡进度 | Raid 与 Rush 仍耦合 |
| 通用结算 | `singleBattleQuest.ts` | `singleBattleQuest.ts` | `singleBattleQuest.ts` | `singleBattleQuest.ts` | 共享且体积较大 |

## 已确认风险

1. 三种模式的配队分类已按国服客户端协议拆分为 Carnival=2、Raid=3、Rush=4。服务端曾把 Raid 的 3 强制映射为 4，并让 Carnival/Raid/Rush 路由都读取 4；Rush 还曾对 12 个组重复返回槽位 ID `1..10`。分类与全局 ID 冲突均已修复，待客户端验收。
2. Raid 使用 `players_rush_events_played_parties` 和 `RushEventBattleType.FOLDER` 保存出战队伍。字段目前足够，但命名、生命周期和未来迁移都与 Rush 绑定。
3. 单人和多人结算分别实现了经验、Mana、进度、奖励和统计更新。两条路径已经出现字段取值差异，后续新增关卡规则需要改两处。
4. `getQuestFromCategorySync()` 是集中式 category switch。新增模式必须同时修改资源加载、路由注册、开始和结算分派。
5. 特有 handler 通过大量函数参数注入数据库操作，测试方便，但缺少统一的 `start/finish/abort/serialize` 模式契约。
6. 无限演武仍复用共享路由中的基础结算实现，但 category 27 会把基础玩家字段、普通掉落、任务统计、角色经验、跨档奖励、进度和 active quest 删除整体包入一个 SQLite 事务；普通 category 保持原路径。

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
- Raid 修正列偏移，并在结算返回客户端必需的 `raid_event`；finish 按官方权重模型推进共享 Boss 和分关卡次数，事件级累计击破奖励由 summary 按玩家游标原子发放并完整解析 10 个奖励槽。当前仍需客户端确认奖励数量、动画和页面刷新。
- Rush/Raid 失败结算不再推进模式进度。
- Rush endless 下一轮按 round 排序。
- 特殊关卡配队按 Carnival=2、Raid=3、Rush=4 独立保存和读取；配队组颜色使用请求分类更新并在页面重载时返回持久化值。
- Rush 的 12 组队伍统一使用全局 `party_id=1..120`；禁止把每组内部槽位 `1..10` 直接作为响应 ID。
- Advent 多人结算按真实房主身份持久化 `host_finished`，并在 load 恢复；歼灭者最高难度不新增服务端私有解锁规则，继续由客户端按原生 Quest Set 条件判断。
- 配队及配队组编辑端点只接受整数分类 1 至 4，避免创建客户端无法访问的协议外数据。
- 历史 `category=4` 配队按“目标分类 > 历史数据 > 默认队伍”的顺序补齐，使用只插入缺失记录的方式保留现有数据。
- Carnival 171 行、Raid 50 行运行资产均完成字段完整性检查。
- 无限演武使用官方 category 27；123 个关卡全部恢复 10 体力消耗，旧 category 9 映射已删除。
- 无限演武 11,100 条分数奖励保留奖励行 ID、分数线、原因 ID 和最多 6 个奖励槽；结算按 `(旧最高分, 新最高分]` 发放全部跨越档位。
- 无限演武按 B/A/S/SS 分数阈值计算 C/B/A/S/SS 评级，并返回客户端必需的 `score_attack_event.main_character_ids/reward_ids`。
- 当前 11,100 行奖励 kind 扫描结果仅为 `{0}`；运行逻辑完整支持当前道具奖励，其他未出现 kind 明确拒绝并回滚，不推测未来类型。
- 超级猫头鹰是 category 2 的普通 Boss Battle 扩展，不并入四种活动模式。内容转换器从 `boss_battle_quest` 第 122 列识别 `1001002`、`1001003` 两个 BothBoss 入口；联机 TCP 在同一 active quest 内完成两代 SceneReady 和 LevelNext，最终仍只执行一次 HTTP finish。

以上属于代码和资产检查结果，不代表客户端进入、配队和结算已经验收通过。
