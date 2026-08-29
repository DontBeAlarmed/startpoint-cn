# 存档 v2：导出、恢复与克隆

管理 API 使用 `starpoint-cn-save` 快照备份玩家状态。格式 v2 直接保存 SQLite 玩家领域行，不再依赖面向客户端的 `MergedPlayerData`，因此能覆盖邮件、商店、活动履历和后续新增的玩家表。

## 快照格式

`GET /api/player/save?id=<playerId>` 导出：

```json
{
  "schema": "starpoint-cn-save",
  "version": 2,
  "formatVersion": 2,
  "mode": "backup",
  "exportedAt": "...",
  "playerId": 1,
  "producer": {
    "serverVersion": "1.0.1",
    "dbSchemaVersion": 18,
    "contentVersion": "1.4.54"
  },
  "domains": {
    "core": { "version": 1, "tables": {} },
    "missions": { "version": 1, "tables": {} },
    "events": { "version": 1, "tables": {} },
    "economy": { "version": 1, "tables": {} },
    "mailbox": { "version": 1, "tables": {} }
  },
  "excludedDomains": ["account", "session", "serverConfig", "activeQuest"]
}
```

`version` 是旧管理端兼容字段；v2 解析以 `formatVersion` 为准。`producer` 记录生成快照时的服务端、数据库 schema 和 Content 版本，用于拒绝不能安全向后恢复的数据。

## 覆盖范围

schema 21 共有 64 张可从 `players` 外键图发现的玩家关联表：

- 61 张登记到 `core`、`missions`、`events`、`economy`、`mailbox`；
- `players_active_quests`、`scheduled_resource_rules` 和
  `players_scheduled_resource_state` 明确排除；
- 邮件、领取历史、活动扭蛋箱明细、Pass、Raid、登录奖励游标、商店购买计数、campaign lineup、EX 待选结果、玩家履历设置、练习战和无限演武战斗履历均可往返。

注册表位于 `src/data/player-save/registry.ts`。测试会动态遍历当前 SQLite 外键图，并要求发现结果与“已登记 + 明确排除”完全相等。以后新增玩家表但未登记时，CI 会失败，不再静默漏出快照。

导出时，外键图检查产生的表列元数据会复用于各表主键排序，不会为同一张表再次执行 `PRAGMA table_info`。
恢复、克隆和模板校验也复用同一次 schema inspection：列校验、外键插入顺序、目标列筛选都不再重复执行
`PRAGMA table_info` 或 `PRAGMA foreign_key_list`。这只减少 schema introspection，不改变行排序、快照字段、
外键顺序或跨版本规则；真实数据行仍按每张登记表独立查询，事务和失败回滚语义不变。

以下状态不属于单玩家存档：

| 表或领域 | 原因 |
|---|---|
| `accounts` | 账号身份和认证 |
| `sessions` | 登录令牌 |
| `device_bindings` | 设备绑定 |
| `server_gameplay_settings` | 服务端全局配置 |
| `raid_event_boss_states` | 全服 Raid 共享状态 |
| `players_active_quests` | 进行中战斗、房间和预扣资源 |
| `scheduled_resource_rules` | 服主配置的全局或指定存档补充规则 |
| `players_scheduled_resource_state` | 与当前服务端规则 ID 绑定的发放状态 |

恢复和克隆都会清理目标玩家的 `players_active_quests`。数据库事务成功后还会清除进程内 `activeQuests`；事务失败时两处状态均保留。这样旧战斗不能在已经替换的背包、体力或门票状态上继续结算。

定时资源补充规则及其发放状态不导出，也不会在恢复时清理目标服现有记录，避免跨服导入携带无效规则 ID 或重置当天发放状态。

## Restore 与 Clone

恢复写入现有玩家：

- 保留目标 `players.id` 和 `account_id`；
- 替换所有已登记玩家领域；
- 不复制账号、设备、会话和服务器配置；
- `players.time_offset` 统一写为 `NULL`，运行时只使用全局服务器时间；
- 整个操作在单一 SQLite 事务中执行，任一表失败即回滚。

克隆先在目标账号创建新玩家，再使用独立策略写入：

- 新玩家 ID 和目标账号关系由服务器分配；
- `players_mails`、`players_receive_history`、`players_practice_battle_history`、`players_score_attack_battle_history` 的自增 ID 重新生成；
- `players_tutorial_step_receipts` 不复制，避免向新玩家重放源存档缓存的旧教程响应；
- 业务主键和玩家进度按原值复制。

## 跨版本规则

- 来源 `dbSchemaVersion` 高于当前服务器：拒绝导入，防止未知表或字段被静默丢弃。
- 来源版本较旧：允许缺少在来源 schema 之后才引入的表，并按空表处理。
- 来源版本当时已经存在的登记表缺失：拒绝导入。
- 来源包含当前数据库未知的表或列：拒绝导入。
- 目标数据库新增列时，快照按列名映射；来源未提供的列保留目标默认值或当前值。

结构兼容不等于 Content 兼容。角色、装备、任务、商店和活动记录都含 Content ID；把快照导入缺少对应 ID 的 CDN/Content 版本，可能产生不可用状态。当前项目只保证官方客户端和对应官方 CDN 环境，不为修改后的 Content 做恢复兜底。

## v1 兼容

旧格式仍可导入：

```json
{
  "schema": "starpoint-cn-save",
  "version": 1,
  "data": { "player": {} }
}
```

v1 明确标记为 `legacyPartial=true`，不能作为完整备份。它只更新旧 `MergedPlayerData` 能完整表达的领域；邮件、商店计数、Pass、Raid、履历等新领域会保留目标玩家导入前的状态，不再被旧导入流程级联清空。活动扭蛋箱的父表和已抽奖励明细也会整体保留，因为 v1 只有父表，单独恢复父表会造成奖池不一致或外键失败。

默认存档模板同时接受 v1 和 v2。新模板应使用管理端当前导出的 v2；v1 仅用于兼容历史文件。

默认模板应用到新存档时使用 clone 策略，因此不会复制 `players_tutorial_step_receipts` 中缓存的源玩家教程响应。

模板上传会先做结构校验，再在事务中的临时账号与玩家上完整试恢复，最后主动回滚。主键、唯一约束或外键不一致会在上传时返回错误，不会保存成一个以后只能静默退回空存档的模板。

## 管理写入边界

快照恢复面向管理员的可信备份，不是任意编辑器或 Mod 数据接口。结构校验会拒绝未知表、未知列、外来 `player_id` 和不支持的 JSON 值，但不会重新计算每个业务字段的游戏平衡约束。

快照也不是游戏客户端 `/load` 响应，不能交给客户端反序列化。存档恢复后仍应通过正常登录和 `/load` 流程完成客户端状态刷新。

管理 API 的单文件上传上限为 64 MiB，高于旧版 5 MB 限制，用于容纳邮件、领取历史和战斗履历。导出使用同一字节上限，超限时返回明确错误；因此管理 API 成功导出的文件一定处于上传可接受范围。该上限仍是内存与滥用保护；超大历史存档需要先缩减历史数据，当前不提供流式快照格式。
