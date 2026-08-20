# 角色重复数消耗审计

> 客户端验收：已通过（2026-07-17）。角色分解后重复数、经验池和星之粒变化符合预期。

## 结论

用户观察到的“角色转换后重复数不消耗”属实，问题位于单角色转换 `POST /expod/stack_to_exp`，不是角色突破。

## 路径对比

| 操作 | 端点 | 审计结果 |
|---|---|---|
| 使用重复角色突破 | `/character/over_limit` | 正确执行 `stack - over_limit_count` 并持久化 |
| 一键突破 | `/character/bulk_over_limit` | 正确按可突破步数扣除 stack |
| 单角色转换为经验/星之粒 | `/expod/stack_to_exp` | 原实现只计算并返回 `afterStack`，未写数据库 |
| 一键转换 | `/expod/bulk_stack_to_exp` | 正确把符合条件的 stack 写为 0；全部角色与奖励共享事务 |
| 角色保护 | `/character/set_protection` | 批量设置角色保护状态；一键转换跳过已保护角色 |

## 根因与影响

原单角色转换按重复数发放经验池和星之粒，但没有调用 `updatePlayerCharacterSync()`。客户端可能因响应中的 `stack` 暂时显示为已扣除；重新 load 后会从数据库恢复旧 stack，因此同一重复角色可以反复转换并重复领取奖励。

## 修复

- 在同一个 SQLite 事务内扣除角色 stack、增加经验池和发放星之粒。
- 单角色转换与 CN 客户端一致：只要求角色未保护且重复数充足，不要求满突破。
- 批量转换继续只处理满突破且有重复数的角色；这是批量入口独有的筛选条件。转换会先生成完整计划，再在一个事务中清空全部 stack、增加经验池、发放星之粒并记录累计获得事实，后段失败不会只消耗前几个角色。
- 批量转换与单角色转换共享“保护角色不可转化”边界；批量入口会跳过已保护角色，不会因一键操作误消耗其重复数。
- `/character/set_protection` 现在提供与装备保护相同的批量设置入口，并在响应中返回实际写入的角色保护状态；未知角色按兼容语义跳过。
- `number` 与 `over_limit_count` 必须为正整数，阻止 0、负数和小数构造异常库存。
- 响应 `update_time` 使用本次操作时间，避免回传旧时间。

CN 1.8.1 离线逻辑 `ExpodStackToExpDummyRemote` 明确调用 `consumeCharacterStack(characterId, number)`；本次修复与该行为对齐。

`ConvertToExpWindow.getConversionAvailability()` 仅检查 `protection` 和
`stack == 0`。将批量入口的满突破条件用于单角色入口会导致合法请求返回
HTTP 400，并触发客户端 H400；该限制已移除。
