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
| 队伍 | `PartyCategory.EVENT` | `PartyCategory.EVENT` | `PartyCategory.EVENT` | 共享且互相覆盖 |
| 玩家状态 | Rush 表 | Carnival 专用表 | 复用 Rush played-party 表 | Raid 与 Rush 耦合 |
| 通用结算 | `singleBattleQuest.ts` | `singleBattleQuest.ts` | `singleBattleQuest.ts` | 共享且体积较大 |

## 已确认风险

1. 无限激战当前已确认存在“配队无法保存”的客户端问题。三种模式都保存到 `PartyCategory.EVENT`，进入另一模式后看到或修改的是同一套活动队伍，不具备模式级隔离；下一阶段应先抓取无限激战配队保存请求，确认问题发生在请求未发送、category 映射还是服务端持久化。
2. Raid 使用 `players_rush_events_played_parties` 和 `RushEventBattleType.FOLDER` 保存出战队伍。字段目前足够，但命名、生命周期和未来迁移都与 Rush 绑定。
3. 单人和多人结算分别实现了经验、Mana、进度、奖励和统计更新。两条路径已经出现字段取值差异，后续新增关卡规则需要改两处。
4. `getQuestFromCategorySync()` 是集中式 category switch。新增模式必须同时修改资源加载、路由注册、开始和结算分派。
5. 特有 handler 通过大量函数参数注入数据库操作，测试方便，但缺少统一的 `start/finish/abort/serialize` 模式契约。

## 建议演进顺序

1. 先抽取共享 `QuestFinishService`，让 single/multi 共用奖励、角色经验、关卡进度和统计更新事务。
2. 定义轻量 `QuestModeHandler`：`validateStart`、`onStart`、`onFinish`、`onAbort`、`buildResponse`。按 category 注册，不一次性重写现有路由。
3. 为 Raid 建立专用 played-party domain/table；保留兼容读取迁移，避免直接改旧数据。
4. 队伍隔离应依据客户端真实 `party_category` 能力决定。客户端只提供 EVENT 时，服务端不能凭空增加 category；可在 EVENT 下增加服务端 mode scope，但必须验证客户端切换模式时的保存请求。
5. 最后把资源转换器的字段契约加入生成测试，防止 CDN 列偏移再次进入运行资产。

## 本轮已修正的数据/流程

- Carnival 分数使用主数据第 104 列的真实 `difficulty_score`。
- Carnival 第 100 列 `battle_time_limit` 按客户端逻辑从 60 FPS 帧数换算为毫秒；禁止直接作为毫秒使用。
- Raid 修正列偏移，并在结算返回客户端必需的 `raid_event`。
- Rush/Raid 失败结算不再推进模式进度。
- Rush endless 下一轮按 round 排序。
- Carnival 171 行、Raid 50 行运行资产均完成字段完整性检查。

以上属于代码和资产检查结果，不代表客户端进入、配队和结算已经验收通过。
