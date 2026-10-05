# 多人社交与救援联机计划书

## 背景

cond20（累计救援）与 cond92（新手组队）的计数管道已落地（rescue counters），但缺少两个前置功能：
- 铃铛（attention）：新手房主开随机招募 → 投递给在线可加入玩家 → guest 响应进房。
- presence：好友在线状态查询。

A1 在本地 SQLite 上实现铃铛生命周期 + presence（单节点内完整闭环）。
A2 在多节点部署时将社交/协调状态迁入共享 PG 并取消主客身份（独立专项，本文不展开）。

## A1 范围

| 项 | 内容 | 存储 |
|---|---|---|
| attention_recruitments | 招募生命周期表（新手房主开招募） | 本地 SQLite |
| attention_deliveries | 投递/响应/拒绝追踪 | 本地 SQLite |
| /attention/check 扩展 | 返回 data.multi[]（该玩家被投递且未响应的招募） | 既有端点扩展 |
| /attention/action | accept（标记响应）/ decline（标记拒绝） | 既有端点扩展 |
| /multi prepare 扩展 | attention_key 校验 → newbie_rescue_eligible 冻结 | 既有端点扩展 |
| presence 模块 | 内存 Map（player → last_seen），HTTP/TCP 上报 | 零持久化 |

## 明确不做

- 投递冷却/禁入记账全套
- search_twitter/SNS
- 跨节点 battle relay
- 存档共享化
- 节点可达性探测表（单机 loopback 恒通，无信息量）

## 补充（审查建议）

- **招募触发端点**：`/multi_battle_quest/prepare`（房主带随机招募标记的 prepare）创建招募行
- **过期清理**：惰性 — /attention/check 时过滤 expires_at 已过的行
- **presence 来源**：复用 /attention/check 轮询 touch last_seen（原版客户端不加新请求）
- **验收**：新手房主开招募 → guest 轮询见铃铛 → accept 进房 → 完成 → cond92 +1
