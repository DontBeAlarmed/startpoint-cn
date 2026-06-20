# 存档导入/导出 & 写入校验 & 清空邮件箱

> 状态: 已实现   关键文件: src/routes/web_api/{player.ts, validation.ts, mail.ts}, src/data/utils.ts   相关端点: /api/player/save, /api/player/:id/*, /api/mail/send

Web 管理面板对玩家数据的写入安全设计。核心原则:**只做结构安全校验,不卡游戏平衡**——挡住会真正坏档/崩溃的输入(未知字段、类型错误、整数 ≥ 2³¹、负的货币/数量),不限制数值大小;不合理的值靠"导出→微调→重导入"闭环纠正。

## 存档导出 / 导入(MergedPlayerData 快照)

- **导出 `GET /api/player/save?id=<pid>`**:`getMergedPlayerDataSync` 组装玩家完整服务端状态 → `{schema:"starpoint-cn-save", version:1, exportedAt, playerId, data}`,下载为 `save_<id>.json`。
- **导入 `POST /api/player/save?id=<pid>`**:校验 `schema/version` → 复活 Date 字段(`player.{staminaHealTime,lastLoginTime,expPooledTime}`、`characterList[*].{joinTime,updateTime}`、`startDashExchangeCampaignList[*].{periodStartTime,periodEndTime}`)→ `replacePlayerDataSync`(删玩家 + `insertMergedPlayerDataSync`)。
- 绕开游戏客户端的严格反序列化(`deserializePlayerData`,35 处 throw),往返同 schema、稳健;失败逐步明确报错。
- 覆盖域:玩家行 + 角色/魔晶/装备/物品/编队/任务进度+已抽/抽卡 info+campaign/箱抽/狂热活动/任务清单/每日点数/教程/选项。
- **仅用于管理面板备份/恢复**,不保证被游戏客户端直接 load。

## 写入端点校验(`validation.ts`)

违规一律 `400 + 明确中文报错`,不写库。整数硬上限 `MAX_INT = 2³¹-1`。

- `PATCH /:id/field`:字段**白名单**(`Player` 已知可编辑字段,`id` 禁改)+ 类型正确(uint 0~2³¹ / 字符串限长 name≤32·comment≤128 / 布尔 / 可空 / Date 可解析 / timeOffset ±约1000年 可空)。不卡平衡上限;不校验 leaderCharacterId 拥有(允许改存档加角色)。
- `/:id/refill_resources`:amount 0 ~ 99,999,999。
- `/:id/character`:characterId 校验存在于资源表(`character.json`);不设拥有上限。
- `/:id/item`:itemId 校验存在;count 0 ~ 2³¹。

## 邮件发信校验(`mail.ts`)

- type **白名单** `{1,3,4,5,6,7,8,9,10,11,12,15}`。
- type_id:`{1 道具,5 角色,6 装备}` 必填且校验存在(`item_ids.json` / `character.json` / `equipment_ids.json`);其余类型忽略。
- count:**角色(5)、装备(6)必须 = 1**;其余 1 ~ 2³¹。
- subject ≤ 64、description ≤ 512。

> `assets/equipment_ids.json` 由 `scripts/gen_equipment_ids.py` 从 `邮件附件对照表.xlsx` 第3页生成。

## 清空邮件箱(误发非法邮件的兜底恢复)

- `DELETE /api/player/:id/mail` → `deleteAllPlayerMailSync`(`DELETE FROM players_mails WHERE player_id=?`)。
- 玩家详情页「清空邮件箱」按钮(二次确认)。用于误发会让客户端在邮件界面崩溃的非法邮件时恢复。
