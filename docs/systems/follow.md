# 同服 Follow 与跨服房间兼容

> 客户端验收状态：暂缓测试。当前完成代码、内容与专项回归验证。

## 范围

Follow 关系只存在于同一个 `starpoint-cn` 实例和同一套 SQLite 内。跨服玩家不建立、
不迁移、不同步持久关系；离开节点只表示离线。Party Code 与 Twitter 搜索
（`follow/search_twitter`）不在本能力范围内，SNS 绑定保持空兼容。

## 数据模型（schema 28）

- `players_follows(follower_player_id, followed_player_id, followed_at)`：有向边，
  复合主键、self-CHECK、双外键 `ON DELETE CASCADE`（删玩家清理双向边），
  反向索引 `(followed_player_id, followed_at DESC)`。
- 表排除在 player-save 之外（`serverOperation`，见 `src/data/player-save/registry.ts`）。
- 上限来自 Content `config.json`：`max_follows_count=100`（我方关注，超限 →
  A-error 1451）、`max_followers_count=50`（对方被关注，超限 → 1452）、
  `max_display_followers_count=50`。不硬编码。

## 状态派生

`follow_state`（CN 1.8.1 语义）：`0` 无关系、`1` 互相关注、`2` 我→对方单向、
`3` 对方→我单向。由双向边存在性派生（`src/lib/follow/state.ts` 纯函数）；
`follow_time` = 我→对方边时间，`followed_time` = 对方→我边时间（秒级投影）。

## HTTP 协议（`src/routes/api/follow/`）

| 端点 | 行为 |
|---|---|
| `follow/lists` | 有任一方向边的同服玩家投影 + `followed_count`；按 last_login_time 降序、viewer_id 升序 |
| `follow/add` | 单事务；幂等；上限失败 → HTTP 200 + `result_code` 1451/1452 |
| `follow/delete` / `follow/delete_followed` | 幂等删除出边 / 入边 |
| `follow/bulk_edit` | 单事务全或无 |
| `follow/search_id` | 仅解析本地 session（同服边界）；未命中返回空值形态 `search_result` |

业务错误走 HTTP 200 + `data_headers.result_code`（客户端 A-error 通道）；
非法 body / 未认证沿用 400 JSON。

## 多人投影与体力

- 房间字段 `establisher_follow`（`/search_room`、`/verify_access_token`）：
  - 同节点请求者与房主：真实 `follow_state`；
  - **可信跨节点**（两个非空且非 `remote-pending` 的 nodeSessionId 不同）：
  固定投影 `1`。这是**非官方跨服联机兼容策略**：CN 客户端只能通过该字段在
  入场前识别免费体力，副作用是显示互关图标——这是明确接受的兼容行为。
  该值不是关系事实，不得进入 Follow 列表、profile、结算 `follow_info`、
  player-save 或关系表。
  - 不可信身份：`0`（fail-closed，无跨服加成）。
- guest 实际体力（`src/lib/stamina-cost.ts`）：互关（state 1）与可信跨服 guest
  为 `0`；其余（0/2/3）先 `floor(raw × 0.5)` 再应用 Campaign（对折半值）；
  房主保持完整 `getStaminaCost().cost`。实际成本写入 active quest，失败/abort/
  恢复按保存值处理（与既有退款语义一致）。
- 结算 `follow_info`（`src/lib/quest/finish/follow-info.ts`）：同节点队友投影真实
  关系与时间；跨节点队友本地不可解析即跳过（不可关注）；NPC（viewer_id ≥
  900000000）过滤；单队友资料失败 best-effort。

## 信任链

跨服判定只接受 Coordinator 提供的 `nodeSessionId + viewerId`
（`src/multi/follow-policy.ts`）；不得使用客户端自报字段、裸 viewer id、IP 或
URL 推断。
