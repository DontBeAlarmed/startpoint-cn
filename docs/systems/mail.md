# 邮件系统（Mail）
> 状态：游戏内流程已实现；管理后台搜索与定向发送待补全
> 关键文件：`assets/item_ids.json`、`assets/character.json`、`assets/equipment_ids.json`
> 相关端点：`/mail/send`、`/mail/index`、`/api/mail/send`

本文档描述游戏内邮件、管理后台发送、CDN 附件校验，以及邮件到达通知的动态计算。管理后台附件搜索和定向发送的完整分析见 `docs/superpowers/specs/2026-07-19-mail-search-and-targeting-design.md`。

## 邮件到达通知

`mail_arrived` 根据当前存档在 `players_mails` 表中的未领取邮件数量动态计算。存在未领取邮件时为 `true`。

## 管理后台发送目标

`POST /api/mail/send` 当前支持三种目标：

- `playerId`：指定一个存档。
- `accountId`：指定账号下的全部存档。
- 两者都不提供：全服全部存档。

旧 `/mail` 页面不提供目标控件，因此只能全服发送。新 `/admin/mail` 已有三档目标控件，但当前玩家列表默认只返回前 25 条，尚不能可靠覆盖全部存档。

## CDN 附件校验

管理后台发送邮件时会在写入前校验 `type_id`：

- 角色（`type=5`）：校验 `assets/character.json`，当前 505 个 ID。
- 道具（`type=1`）：校验 `assets/item_ids.json`，当前 1284 个 ID。
- 装备（`type=6`）：校验 `assets/equipment_ids.json`，当前 436 个 ID。
- 非法 ID：返回错误，不写入邮件。

`assets/item_ids.json` 来自 CN `orderedmap/item/item.json`。`assets/item_data.json` 只包含带使用效果的部分体力道具，供 `/item/use_item` 使用，不能作为邮件附件白名单。

中文名称查询复用以下只读数据：

- `assets/item_lookup.json`
- `assets/equipment_lookup.json`
- `docs/generated/character_table.json`
