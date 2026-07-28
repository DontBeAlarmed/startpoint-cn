# 体力系统

本文描述当前体力上限、自然恢复、关卡消耗、活动折扣与升级补充规则。关卡门票和入场道具的事务边界见[关卡入场道具](./quest-entry-items.md)。

## 数据来源

| 数据 | 位置 | 用途 |
|---|---|---|
| 玩家体力 | `players.stamina`、`players.stamina_heal_time` | 当前存量与恢复起点 |
| 等级表 | `assets/cdndata/player_rank_full.json` | 等级阈值、自然上限与 `heal_rate` |
| 体力配置 | `assets/config.json` | 每点恢复秒数、恢复道具和溢出上限 |
| 关卡成本 | Content snapshot 的 `quest_entry_costs.json`；`assets/` 仅为兼容 fallback | 按 `category_questId` 保存体力与 Always 道具成本 |
| 活动折扣 | `assets/stamina_campaign.json` | 按关卡类别、ID 与服务器时间选择折扣率 |

`getRankDegree(rankPoint)` 从等级阈值计算当前 degree；`getMaxStamina(degree)` 返回该等级的自然体力上限。

## 自然恢复

`computeRealTimeStamina()` 读取玩家体力、恢复时间、等级和 `heal_rate`：

```text
recoverySeconds = config.stamina_recovery_seconds * (1 - healRate)
recovered = floor((now - staminaHealTime) / recoverySeconds)
```

结果不会低于 0，也不会超过以下三个边界中的最小值：

- 当前等级自然上限与玩家现有体力的较大值；
- 恢复后的计算值；
- 溢出硬上限 999。

这意味着自然恢复不会抹掉已有溢出体力，但也不会让体力继续自然增长超过当前存量或 999。`/load` 会计算并持久化离线恢复结果；相关响应把 `stamina_heal_time` 更新为当前服务器时间，避免客户端在服务端结果上再次累计同一段时间。

## 单人关卡

`/single_battle_quest/start` 使用 `${category}_${questId}` 查找入场成本，再通过 `getStaminaCost()` 应用当前服务器时间内的活动折扣：

```text
cost = max(1, floor(baseCost * activeRate))
```

没有体力成本时返回 0。成功开战在同一个 SQLite 事务中完成：

1. 计算实时体力；
2. 校验体力与入场道具；
3. 扣除体力和道具；
4. 更新队伍槽；
5. 持久化 active quest；
6. 提交后发布内存 active quest。

任一步失败都不保留部分写入。成功响应立即返回扣除后的 `stamina` 和 `stamina_heal_time`。

## 自动连战耗尽

自动连战的下一轮仍然必须通过同一套体力事务校验，服务端不会因为
`is_auto_start_mode=true` 而免除消耗或创建免费 active quest。当下一轮确实因体力不足而无法入场时，事务回滚，不扣体力、不扣门票，也不发布 active quest。

国服客户端没有独立的“自动连战体力不足” start 响应类型。服务端只在自动连战且确定为体力不足时以 HTTP 200 返回 `data_headers.result_code=4050`，避免进入 HTTP/API 全局致命错误路径；普通手动挑战仍返回入场错误。`4050` 的官方含义是 `QuestOutOfPeriod`，客户端会使用“关卡超出开放期”提示和对应返回路由，它不是正常自动连战完成状态，也不保证回到配队页。正常次数耗尽仍应由客户端自身计数器收尾；该兜底只处理客户端额外发起下一轮 start 的异常边界，待真机验收。

单人结算增加 rank point 后重新计算 degree。跨级时，当前实现是在结算前体力上**增加** `getMaxStamina(newDegreeId)`，并重置恢复时间；它不是把体力直接设为 999，也不是简单设为新等级自然上限。

## 多人关卡

多人开战当前没有实现体力扣除，这是与单人流程的明确差异。

多人结算已经实现 rank point 与 degree 更新。跨级时同样在当前体力上增加 `getMaxStamina(newDegreeId)` 并重置恢复时间，然后通过 `user_info` 返回新体力。不得再把“多人升级未实现”作为当前状态。

## 活动折扣

`getActiveCampaignRate()` 使用统一服务器时间匹配：

- `quest_type` 对应关卡类别；
- 可选 `quest_ids` 限制具体关卡；
- 当前时间必须位于活动开放区间；
- 多条规则同时命中时选择最低费率；
- 未命中时费率为 1。

折扣只影响体力，不替代门票或入场道具校验。

## 恢复入口

- `/shop/recover_stamina` 处理付费恢复；
- `/item/use_item` 处理固定值与比例体力道具；
- 恢复后的体力受配置中的溢出上限约束；
- 支付服务只保留兼容边界，不提供真实雷霆商店结算。

## 已知边界

- 多人开战不扣体力；
- 自动连战在体力不足时仍按普通入场返回 H400，客户端缺少官方的非致命停止语义；
- 体力、门票与 active quest 已在单人 start 事务化；单人和协力 finish 的数据库写入也已有总事务，详见[战斗关卡结算事务](./quest-finish-transactions.md)；
- 客户端显示和长时间离线恢复仍需结合服务器 `timeOffset` 做人工验收。

当前项目不按存档单独应用 `time_offset`。活动折扣使用带全局 `timeOffset` 的 `getServerDate()`；自然恢复使用真实 `Date.now()` 计算经过秒数。两者是有意分离的时间来源，非零全局偏移不会加速或倒退玩家的自然恢复。

## 验证入口

主要相关测试：

- `tools/quest_entry_lifecycle.test.cjs`；
- `tools/treasure_key_entry.test.cjs`；
- `tools/quest_host_finish.test.cjs`；
- `tools/event_currency.test.cjs`。

修改体力或关卡入场规则后运行 `npm run test:changed`，模块提交前运行 `npm run verify:full`。
