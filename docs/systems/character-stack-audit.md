# 角色重复数消耗审计

## 结论

用户观察到的“角色转换后重复数不消耗”属实，问题位于单角色转换 `POST /expod/stack_to_exp`，不是角色突破。

## 路径对比

| 操作 | 端点 | 审计结果 |
|---|---|---|
| 使用重复角色突破 | `/character/over_limit` | 正确执行 `stack - over_limit_count` 并持久化 |
| 一键突破 | `/character/bulk_over_limit` | 正确按可突破步数扣除 stack |
| 单角色转换为经验/星之粒 | `/expod/stack_to_exp` | 原实现只计算并返回 `afterStack`，未写数据库 |
| 一键转换 | `/expod/bulk_stack_to_exp` | 正确把符合条件的 stack 写为 0 |

## 根因与影响

原单角色转换按重复数发放经验池和星之粒，但没有调用 `updatePlayerCharacterSync()`。客户端可能因响应中的 `stack` 暂时显示为已扣除；重新 load 后会从数据库恢复旧 stack，因此同一重复角色可以反复转换并重复领取奖励。

## 修复

- 在同一个 SQLite 事务内扣除角色 stack、增加经验池和发放星之粒。
- 仅允许满突破角色转换，和客户端批量转换条件一致。
- `number` 与 `over_limit_count` 必须为正整数，阻止 0、负数和小数构造异常库存。
- 响应 `update_time` 使用本次操作时间，避免回传旧时间。

CN 1.8.1 离线逻辑 `ExpodStackToExpDummyRemote` 明确调用 `consumeCharacterStack(characterId, number)`；本次修复与该行为对齐。
