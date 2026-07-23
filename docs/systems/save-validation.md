# 存档导入、导出与写入校验

当前管理 API 可以导出和替换 `MergedPlayerData` 覆盖的玩家领域，但不代表完整服务端状态快照。新增数据库领域时必须显式接入组装与恢复，否则会在往返后丢失。

## 快照格式

`GET /api/player/save?id=<playerId>` 返回：

```json
{
  "schema": "starpoint-cn-save",
  "version": 1,
  "exportedAt": "...",
  "playerId": 1,
  "data": {}
}
```

`data` 由 `getMergedPlayerDataSync()` 组装。当前覆盖玩家主行、每日挑战点、教程、普通任务清单、角色、Mana Node、编队、物品、装备、关卡进度、抽卡信息、活动 campaign、Active Mission、分类任务、活动扭蛋箱、选项、狂热激战以及土俑分数/奖励/称号状态。

`purchasedTimesList` 当前固定为空对象，不会往返商店购买历史。邮箱、邮件领取历史和进程内多人房间也不在快照中；这份列表不是对所有缺失领域的穷举。

## 导入行为

`POST /api/player/save?id=<playerId>` 只接受：

- `schema = starpoint-cn-save`；
- `version = 1`；
- 存在对象形态的 `data.player`。

导入会恢复已知 Date 字段，把 `data.player.id` 强制设为目标存档 ID，再调用 `replacePlayerDataSync()`。替换过程使用单一 SQLite 事务：删除目标玩家数据后重新插入当前 `MergedPlayerData` 支持的领域；任一插入失败会回滚原存档。

入口只做 schema/version 和基础对象检查，具体字段错误主要在恢复 Date 或数据库插入阶段暴露。它不是一套完整 JSON Schema 校验器，也不保证任意手工编辑文件都能安全导入。

快照仅供当前管理端备份、克隆和恢复，不是游戏客户端 `/load` 响应，不能直接交给客户端反序列化。

## 部分完整性的影响

由于快照是部分覆盖：

- 导入前应保留数据库备份；
- 先用测试存档验证目标版本；
- 新领域表必须同时接入 `getMergedPlayerDataSync()`、`insertMergedPlayerDataSync()` 和专项测试；
- 不能用一次导出/导入成功推断全部玩家状态都已往返；
- 邮件、商店购买次数等缺失领域需要独立迁移或备份策略。

## 管理写入校验

`src/routes/web_api/validation.ts` 对玩家字段编辑提供结构安全白名单：

- `id` 不可修改；
- 无符号整数限制为 `0..2147483647`；
- 名称和评论限制长度；
- 布尔、可空值和 Date 必须能解析；
- 未知字段被拒绝。

角色与道具管理端点还会校验资源 ID；道具数量限制在 int32 安全范围。这里保护的是序列化和数据库结构，不对所有游戏平衡上限做官方规则推断。

邮件附件有独立的类型、ID 与数量规则，见[邮件系统](./mail.md)。

## 破坏性恢复操作

管理 API 还提供清空邮箱、删除关卡进度、删除道具和重置部分任务状态等操作。这些端点不属于存档快照本身，执行前应确认目标存档并保留备份。

## 已知边界

- 没有覆盖所有玩家领域的完整端到端往返矩阵；
- 快照版本只有 v1，尚无跨版本迁移层；
- 导入入口不是完整 JSON Schema 验证；
- 管理端破坏性操作尚无统一撤销机制；
- 完整克隆、跨版本恢复和失败场景仍需系统验收。

当前支持状态应标记为 Partial。
