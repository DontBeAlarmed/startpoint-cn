# 配队装备与魂珠校验

## 规则边界

`/party/edit` 在写入任何队伍或任务计数前，对请求内每个 `party_info_list` 项独立校验持有量：

- 同一 preset 内同一装备 ID 最多出现一次；装备记录的 `stack` 不允许同队重复装备。
- 不同 preset 是可切换预设，可以复用同一件装备。
- 魂珠在同一 preset 内可以重复，但重复次数不得超过 `players_items` 中的实际持有量。
- 不同 preset 的魂珠用量不合并计算。
- 未持有、数量不足或非法 ID 会拒绝整个请求，不再把未持有装备静默改为 `null`。

校验失败沿用 HTTP 400。当前没有足够权威资料证明国服专用业务错误码，因此不新增推测错误码。校验发生在数据库事务之前，不会产生部分配队、主队 ID、Active Mission 或战阵任务写入。

## 客户端依据

国服 1.8.1 的 `PartyLogic`、`PlayerLogic`、`CopySourcePartyDataTools` 与 `OwnedAbilitySoulRepository` 表明：装备重复规则以单个 preset 为边界，魂珠按持有数量计数。服务端只复现这部分可确认语义，不把不同 preset 视为同时出战的库存占用。
