# 多人战斗（Multi Battle Quest）联机系统文档
> 状态: NPC共斗完善 + 真人联机 Phase 1-3 基础就绪 + 战斗恢复数据层   关键文件: src/data/sessionServer.ts, src/data/multiRoom.ts, src/routes/api/multiBattleQuest.ts   相关端点: /api/index.php/multi_battle_quest/*

## 1. API 端点规范

### 1.1 端点列表

全部挂载在 `/api/index.php/multi_battle_quest/` 下，MsgPack→Base64 编码（与 HTTP API 协议一致）。

| 端点 | 状态 | 阶段 | 说明 |
|------|:---:|------|------|
| `get_rooms` | ✅ | 1 | 获取房间列表 |
| `create_room` | ✅ | 1 | 创建房间 |
| `search_room` | ✅ | 1 | 按房号搜索 |
| `select_room` | ✅ | 1 | 选择/加入房间 |
| `prepare` | ✅ | 1 | 准备阶段（自动调 select_room） |
| `summon` | ✅ | 2 | NPC mate 数据下发 |
| `restore_room` | ✅ | 1 | 断线恢复 |
| `share_room` | ✅ | 1 | 分享房间 |
| `verify_access_token` | ✅ | 1 | 验证访问令牌 |
| `micro_community` | ✅ | 1 | CN 专属（桩） |
| `start` | ✅ | 3 | 开始多人战斗 |
| `finish` | ✅ | 3 | 结算多人战斗 |
| `abort` | ✅ | 3 | 放弃多人战斗 |
| `play_continue` | ✅ | 3 | 续关 |
| `disband_room` | ✅ | 1 | 解散房间 |

### 1.2 核心端点详细字段表

#### get_rooms

获取可加入的房间列表。客户端对响应有**严格的类型强制校验**，缺少任一字段即抛 C8700。

**请求体**:
| 字段 | 类型 | 必需 | 示例值 | 说明 |
|------|------|:---:|--------|------|
| `viewer_id` | number | ✅ | `2` | |
| `category_id` | number | ✅ | `8` | QuestCategory 枚举值 |
| `event_id` | number | ❌ | `1` | 活动 ID 过滤 |

**响应体 `data.rooms[i]`** — 11 个强制字段:
| # | 字段 | 客户端类型 | 当前值来源 | 示例值 | 说明 |
|:-:|------|:--------:|------|--------|------|
| 1 | `category_id` | Int | `room.category` | `8` | |
| 2 | `quest_id` | Int | `room.quest_id` | `1002` | |
| 3 | `room_number` | String | `room.room_number` | `"506880"` | 6 位数字字符串 |
| 4 | `estabilisher_character` | **Int** | DB `player.leaderCharacterId` | `131012` | ⚠️ 必须 ≤65535，否则 MsgPack uint32 编码致 C8700 |
| 5 | `estabilisher_character_evolution_img_level` | Int | 硬编码 | `0` | |
| 6 | `estabilisher_follow` | Int | 硬编码 | `1` | 1=未关注，2=已关注 |
| 7 | `estabilisher_name` | String | `"Player" + viewerId` | `"Player5"` | |
| 8 | `host_entry_time` | Float | `room.host_entry_time` | `1723648978` | Unix 时间戳（秒） |
| 9 | `is_pickup` | Bool | 硬编码 | `false` | 是否为置顶招募房间 |
| 10 | `mates` | **Int** | `room.mates.length` | `2` | ⚠️ 是 Int 计数，不是对象数组 |
| 11 | `raising_state` | Int | `room.raising_state` | `1` | 1=Ready, 2=Recruiting, 3=Filled, 4=Battle |

**实现位置**: `src/data/multiRoom.ts:196-209` `serializeRoom()`

---

#### create_room

创建新房间，返回 6 位数字房号和临时令牌。

**请求体**:
| 字段 | 类型 | 必需 | 示例值 | 说明 |
|------|------|:---:|--------|------|
| `category` | number | ✅ | `8` | QuestCategory |
| `quest_id` | number | ✅ | `1002` | |
| `party_id` | number | ✅ | `1` | 房主当前队伍 ID |
| `viewer_id` | number | ✅ | `2` | |
| `api_count` | number | ✅ | `1` | |

**响应体 `data`**:
| 字段 | 类型 | 来源 | 示例值 | 说明 |
|------|------|------|--------|------|
| `access_token` | string | 硬编码 | `"multi_access_token"` | 临时令牌（未使用，`verify_access_token` 中废弃） |
| `room_number` | string | 随机生成 | `"506880"` | 6 位数字，`randomInt(100000,999999)` |
| `room_url` | string | 硬编码 | `""` | 分享链接（未使用） |

**数据库操作**: 从 `getViewerIdAndPlayer()` → DB 查 `player.leaderCharacterId` → 存入 `room.host_main_character_id`

**实现位置**: `src/routes/api/multiBattleQuest.ts:224-249` `create_room`, `src/data/multiRoom.ts:112-141` `createRoom()`

---

#### search_room

按 6 位数字房号搜索房间是否存在。

**请求体**:
| 字段 | 类型 | 必需 | 示例值 | 说明 |
|------|------|:---:|--------|------|
| `room_number` | string | ✅ | `"506880"` | |
| `viewer_id` | number | ✅ | | |
| `api_count` | number | ✅ | `1` | |

**响应体 `data`**:
| 字段 | 类型 | 来源 | 示例值 | 说明 |
|------|------|------|--------|------|
| `room_exists` | bool | `!!getRoom()` | `true` | |
| `category_id` | number | 房间或 0 | `8` | 房间不存在时为 0 |
| `quest_id` | number | 房间或 0 | `1002` | |
| `room_number` | string | 请求体 | `"506880"` | 原样返回 |
| `establisher_viewer_id` | number | 房间或 0 | `5` | |
| `establisher_follow` | bool | 硬编码 | `false` | |

**实现位置**: `src/routes/api/multiBattleQuest.ts:252-277` `search_room`

---

#### select_room

选择/加入房间，返回 TCP 会话服务器的连接地址。

**请求体**:
| 字段 | 类型 | 必需 | 示例值 | 说明 |
|------|------|:---:|--------|------|
| `category` | number | ✅ | `8` | |
| `quest_id` | number | ✅ | `1002` | |
| `party_id` | number | ✅ | `1` | |
| `accepted_type` | number | ✅ | `0` | |
| `viewer_id` | number | ✅ | | |
| `room_number` | string | ² | `"506880"` | 与 `access_token` 二选一 |
| `access_token` | string | ² | | 与 `room_number` 二选一 |
| `api_count` | number | ✅ | `1` | |

**响应体 `data`** — 11 个字段:
| 字段 | 类型 | 来源 | 示例值 | 说明 |
|------|------|------|--------|------|
| `application_update_url` | String | 硬编码 | `""` | |
| `category_id` | Int | `room.category` | `8` | |
| `host_entry_time` | Float | `room.host_entry_time` | `1723648978` | 房主最后进入时间 |
| `ip_address` | String | 环境变量 | `"<LAN_IP>"` | TCP 会话服务器 IP |
| `port` | Int | 环境变量 | `8003` | TCP 会话服务器端口 |
| `quest_id` | Int | `room.quest_id` | `1002` | |
| `raising_state` | Int | `room.raising_state` | `1` | |
| `room_number` | String | 房间 | `"506880"` | |
| `room_sequence` | Int | 全局自增 | `42` | |
| `share_room_options` | Int | 硬编码 | `0` | |
| `is_pickup` | Option\<Bool\> | 硬编码 | `null` | null = None |

**实现位置**: `src/routes/api/multiBattleQuest.ts:279-303` `select_room`, `src/data/multiRoom.ts:222-235` `serializeRoomConnection()`

---

#### prepare

准备阶段，自动调用 `select_room`。客户端 `MultiBattleQuestPrepareRealRemote` 收到 `raising_state=1` 后直接走 `select_room`。

**请求体**:
| 字段 | 类型 | 必需 | 示例值 | 说明 |
|------|------|:---:|--------|------|
| `category` | number | ✅ | `8` | |
| `quest_id` | number | ✅ | `1002` | |
| `viewer_id` | number | ✅ | | |
| `room_number` | string | ² | | 与 `access_token` 二选一 |
| `access_token` | string | ² | | |
| `api_count` | number | ✅ | `1` | |

**响应体**: 与 `select_room` 完全相同。

**实现位置**: `src/routes/api/multiBattleQuest.ts:305-331` `prepare`

---

#### summon

获取 NPC mate 队友数据。服务端生成 2 个 NPC（mate1, mate2），每个含完整队伍信息。

**请求体**:
| 字段 | 类型 | 必需 | 示例值 | 说明 |
|------|------|:---:|--------|------|
| `category_id` | number | ✅ | `8` | |
| `quest_id` | number | ✅ | `1002` | |
| `room_number` | string | ✅ | | |
| `viewer_id` | number | ✅ | | |
| `api_count` | number | ✅ | `1` | |

**响应体 `data`**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `mate1` | MultiMate \| null | NPC 1，com_id=1 |
| `mate2` | MultiMate \| null | NPC 2，com_id=2 |

**MultiMate 子结构**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `com_id` | number | 1 或 2 |
| `degree_id` | number | 称号 ID |
| `rank` | number | 等级 |
| `party.characters[]` | Array\<Object\> | 主位角色（固定 3 个） |
| `characters[i].id` | number | 角色 ID |
| `characters[i].evolution_level` | number | 进化等级 |
| `characters[i].exp` | number | 经验值 |
| `characters[i].over_limit_step` | number | 超越等级 |
| `characters[i].mana_node_ids` | number[] \| null | 玛那板解锁节点 |
| `characters[i].ex_boost` | { ability_id_list, status_id } \| null | EX 能力 |
| `party.unison_characters[]` | Array\<Object\> | 副位角色（与 characters 结构相同） |
| `party.equipments[]` | Array\<Object\> | 装备（固定 3 个） |
| `equipments[i].equipment_id` | number | 装备 ID |
| `equipments[i].level` | number | 等级 |
| `equipments[i].enhancement_level` | number | 强化等级 |
| `party.ability_soul_ids[]` | (number \| null)[] | 能力魂 ID（3 个空位） |

**实现位置**: `src/data/multiRoom.ts:55-102` `buildNpcMate()`, `src/routes/api/multiBattleQuest.ts:332-365` `summon`

---

#### start (multi)

开始多人战斗。与 single_battle_quest/start 共用 `insertActiveQuest` 机制，额外记录房间信息。

**请求体** — 在 single 版基础上增加:
| 字段 | 类型 | 必需 | 示例值 | 说明 |
|------|------|:---:|--------|------|
| `room_number` | string | ✅ | `"506880"` | |
| `mate_player_ids` | number[] | ✅ | `[]` | 队友 viewerId 数组 |
| `mate_party_ids` | object[] | ✅ | `[]` | 队友队伍信息 |
| `combat_power` | number | ✅ | `5000` | 战斗力 |
| `attention_key` | string | ❌ | | 协作匹配 key |

**响应体**: 与 single 版类似，`is_multi: "multi"`。

**实现位置**: `src/routes/api/multiBattleQuest.ts:466-526` `start`

---

#### finish (multi)

多人战斗结算。与 single_battle_quest/finish 共用奖励逻辑，额外返回 multi 专属字段。

**请求体** — 在 single 版基础上增加:
| 字段 | 类型 | 必需 | 示例值 | 说明 |
|------|------|:---:|--------|------|
| `contribution_score` | number | ✅ | `250` | 贡献分 |
| `mate_player_result[]` | array | ✅ | `[{viewer_id,com_id,score,contribution_score}]` | 队友战果 |
| `isolated` | boolean | ✅ | `false` | 隔离环境 |
| `priority_factors` | string[] | ✅ | `[]` | 优先因素 |
| `sub_statistics` | object[] | ❌ | | |

**响应体**: 在 single 版基础上增加:
| 字段 | 类型 | 说明 |
|------|------|------|
| `mate_player_result` | array | 队友战果（原样返回） |
| `contribution_score` | number | 贡献分 |
| `host_finished` | boolean | `true` |
| `aborted_play_id` | null | |
| `drawn_quest` | null | |
| `follow_info` | null | |
| `party_info` | null | |
| `unfinished_play_id` | null | |
| `carnival_event` | null | |
| `ranking_event` | null | |
| `score_attack_event` | null | |
| `solo_time_attack_event` | null | |
| `user_notice_list` | [] | |
| `user_periodic_reward_point_list` | [] | |

**实现位置**: `src/routes/api/multiBattleQuest.ts:532-780` `finish`

---

#### abort (multi)

放弃多人战斗。清理 activeQuest 和房间。

**请求体** — 在 single 版基础上增加:
| 字段 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `sub_statistics` | object[] | ❌ | |
| `reproduce_log_data` | object | ❌ | |

**响应体**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `is_multi` | string | `"multi"` |
| `aborted_play_id` | string | 放弃的 play_id |
| `unfinished_play_id` | null | |
| `drawn_quest` | null | |
| `party_info` | null | |
| `presigned_url` | null | |

**实现位置**: `src/routes/api/multiBattleQuest.ts:785-822` `abort`

---

#### play_continue (multi)

续关，与 single 版逻辑完全相同。

**请求体**:
| 字段 | 类型 | 必需 | 说明 |
|------|------|:---:|------|
| `payment_type` | number | ✅ | `1` (固定) |
| `quest_id` | number | ✅ | |
| `viewer_id` | number | ✅ | |
| `paly_id` | string | ✅ | |
| `category` | number | ✅ | |
| `api_count` | number | ✅ | |

**响应体**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `user_info.free_vmoney` | number | 续关后剩余免费星导石 |
| `user_info.vmoney` | number | 续关后剩余付费星导石 |
| `mail_arrived` | boolean | `false` |

**实现位置**: `src/routes/api/multiBattleQuest.ts:828-870` `play_continue`

---

#### restore_room, share_room, verify_access_token, micro_community

| 端点 | 请求关键字段 | 响应 | 状态 |
|------|------------|------|:---:|
| `restore_room` | `room_number`, `room_sequence`, `viewer_id` | 同 `select_room` 响应；房间不存在时返回 fallback（ip=8003, port=0） | ⚠️ 桩 |
| `share_room` | `category`, `quest_id`, `room_number`, `share_type_list` | `{}` | ⚠️ 桩 |
| `verify_access_token` | `access_token`, `viewer_id` | `{room_exists, category_id, quest_id, room_number, estabilisher_viewer_id, estabilisher_follow}` | ⚠️ 桩 |
| `micro_community` | `category_id`, `quest_id`, `room_number`, `viewer_id` | `{micro_community_list: [], page_token: ""}` | ⚠️ 桩（CN 专属） |

---

## 2. TCP 会话协议

### 2.1 连接流程（Phase 1 当前状态：仅创建房间，无 NPC）

```
客户端                                    服务端 (TCP :8003)
  │                                         │
  ├─ XMLSocket.connect(ip, port) ────────────►
  │                                         │
  ├─ 握手 (纯 JSON 字符串) ──────────────────►
  │  {"reconnected":0,                     │
  │   "socklet":"cooperation_room",        │
  │   "viewerId":<number>,                 │
  │   "roomNumber":"<string>",             │
  │   "questCategory":<int>,               │
  │   "questId":<int>}                     │
  │                                         ├─ Accept (t=0)
  │  ◄────────────────── [0, roomId, ""]  ─┤
  │                                         ├─ Welcome (t=100ms)
  │  ◄──── [1,[0,yourself,[yourself]]] ────┤   yourself 从 DB 读取
  │                                         ├─ Mates (t=200ms)
  │  ◄──── [1,[1,[yourself]]] ──────────────┤   mates 仅包含自己（C15202 防护）
  │                                         │
  ├─ Enter notify ──────────────────────────►  客户端状态数据
  │  [0,[0,{partyData,partyId}]]          │
  │                                         │
  ├─ Heartbeat (每 5 秒) ───────────────────►
  │  [0,[4]]                              │
  │  ◄───────── [1,[10,"viewerId"]] ────  │  AckHeartbeat
  │                                         │
  ├─ Bye / 关闭 ────────────────────────────►
  │  [0,[1]]                              │
  X (断开)                                  │  removeClient → disbandRoom
```

**Phase 1 关注点**:
- Welcome 的 `mates: [yourself]` — 包含房主自己，避免 C15202
- `yourself.state: [0]` — Preparation（未准备），待 Phase 2 NPC 加入后由服务端改为 [1]
- 延迟 100ms/200ms 避免 TCP 合并导致握手解析失败
- NPC 加入 → 招募按钮协议 — Phase 2 待调研

**Phase 2 待实现**:
- 客户端点"招募" → 服务端接收 → Mates 更新为 [yourself, NPC1, NPC2]
- NPC state=[1]（已准备）→ 全部非房主成员 Ready → checkAndSyncHostState → 房主 state=[1]
- 房主"开始"按钮可点 → StartBattle → Start(members)

### 2.2 消息格式

**Wire format**: JSON 字符串 + `\0` 结尾（Flash XMLSocket 协议）

**类型**: typepacker 序列化，配置为 `useEnumIndex=true`, `forceNullable=true`

**编码规则**: 每个 Haxe enum 序列化为数组 `[index, param1, param2, ...]`，其中：
- 静态常量子枚举（如 `Heartbeat`）无参数，仅 `index`
- 带参数枚举（如 `Enter(info, id)`）为 `[index, info, id]`
- `Option<T>` 序列化为 `[0, value]` (Some) 或 `[1]` (None)
- 嵌套枚举递归展开

### 2.3 枚举索引对照表

#### HandshakeResult
| 枚举 | Index | 参数 |
|------|:-----:|------|
| Accept | 0 | `(roomId: String, roomUrl: String)` |
| Denied | 1 | `(reason: String)` |
| Reconnect | 2 | `(host: String, port: Int)` |
| Exception | 3 | `(reason: String)` |
| Complete | 4 | (无) |

#### MeetingServer2Client
| 枚举 | Index | 参数 |
|------|:-----:|------|
| Error | 0 | `(ServerErrorMessage)` |
| Message | 1 | `(MeetingServerMessage)` |
| Messages | 2 | `(broadcaster: String, messages: Array)` |

#### MeetingServerMessage
| 枚举 | Index | 参数 |
|------|:-----:|------|
| Welcome | 0 | `(yourself: Object, mates: Array)` |
| Mates | 1 | `(mates: Array)` |
| StateChanged | 2 | `(viewerId: String, state: ReadyState)` |
| AutoplayModeChanged | 3 | `(viewerId, auto: Bool, manual: Bool)` |
| AutoStartChanged | 4 | `(viewerId, autoStart: Bool)` |
| Start | 5 | `(members: Array<Object>)` |
| Disbanded | 6 | `(reason: String)` |
| RemainingTime | 7 | `(time: Int)` |
| Update | 8 | `(reason: String)` |
| StartRemainingTime | 9 | `(time: Int)` |
| AckHeartbeat | 10 | `(viewerId: String)` |

#### Client2Server
| 枚举 | Index | 参数 |
|------|:-----:|------|
| Notify | 0 | `(MeetingNotifyMessage)` |
| Broadcast | 1 | `(Array<MeetingBroadcastMessage>)` |
| Send | 2 | `(Array, Object)` |

#### MeetingNotifyMessage
| 枚举 | Index | 参数 |
|------|:-----:|------|
| Enter | 0 | `(partyInfo: Object, partyId: Int)` |
| Bye | 1 | (无) |
| ChangeParty | 2 | `(party: Object, fromAutoStart: Bool, partyId: Int)` |
| Ready | 3 | `(state: ReadyState)` |
| Heartbeat | 4 | (无) |
| StartBattle | 5 | (无) |
| Suspend | 6 | (无) |
| ChangeAutoplayMode | 7 | `(auto: Bool, manual: Bool)` |
| ChangeAutoStart | 8 | `(enable: Bool)` |
| Log | 9 | `(msg: String)` |
| EnterComs | 10 | `(coms: Array)` |

#### ReadyState
| 枚举 | Index |
|------|:-----:|
| Preparation | 0 |
| Ready | 1 |

---

## 3. 房间生命周期状态机

```
                    ┌──────────────┐
                    │ create_room  │
                    └──────┬───────┘
                           │ raising_state=1
                    ┌──────▼───────┐
                    │  select_room │ ← prepare 自动调用
                    └──────┬───────┘
                           │ 返回 ip+port
                    ┌──────▼───────┐
              ┌─────│  TCP connect │
              │     └──────┬───────┘
              │            │ handshake Accept
              │     ┌──────▼───────┐
              │     │  Welcome+Mates│
              │     └──────┬───────┘
              │            │
              │     ┌──────▼───────┐
              │     │   房间等待    │ ◄── Heartbeat 循环
              │     └──┬───┬───┬───┘
              │        │   │   │
              │     Bye│ Ready StartBattle
              │        │   │   │
              │        │   │   └──────────────┐
              │        │   │                  │
         ┌────▼──┐ ┌───▼───▼──┐      ┌───────▼──────┐
         │ disband│ │StateChanged│     │ summon → start│
         │ room   │ └───────────┘      └───────┬──────┘
         └────────┘                            │ raising_state=4
                                    ┌──────────▼──────────┐
                                    │    战斗进行中        │
                                    └──────┬──────┬──────┘
                                           │      │
                                      finish    abort
                                           │      │
                                    ┌──────▼──────▼──────┐
                                    │    disband room    │
                                    └───────────────────┘
```

**清理机制**:
- TCP 最后一个客户端断开 → `removeClient()` → `disbandRoom()`
- `finish`/`abort` 处理完成后 → `disbandRoom()`
- 定时器每 60 秒清理超过 10 分钟且 `raising_state ≤ 2` 的过期房间

---

## 4. NPC Mate 数据格式

### 4.1 summon 响应格式

```typescript
interface MultiMate {
    com_id: number       // 1=NPC1, 2=NPC2, 或真实 viewerId
    degree_id: number
    rank: number
    party: {
        characters: Array<Option<{
            id: number
            evolution_level: number
            exp: number
            over_limit_step: number
            mana_node_ids: Option<number[]>
            ex_boost: Option<{ ability_id_list: number[], status_id: number }>
        }>>
        unison_characters: Array<同上>
        equipments: Array<Option<{
            equipment_id: number
            level: number
            enhancement_level: number
        }>>
        ability_soul_ids: Array<Option<number>>
    }
}
```

### 4.2 Welcome/Mates/Start 中的 mate 对象格式

```typescript
interface MateEntry {
    // 身份
    viewerId: number         // 正数为玩家，-1/-2 为 NPC
    comId?: number           // NPC 专属
    name: string
    connectionId?: string    // 唯一连接标识
    isHost: boolean

    // 玩家属性
    playerRoleKind?: number
    rank: number
    degreeId: number

    // 队伍 — 与 summon 格式相同，使用 Option 包裹
    party: {
        characters:        Array<Option<{...}>>
        unison_characters: Array<Option<{...}>>  // 注意: snake_case!
        equipments:        Array<Option<{equipmentId, level, enhancementLevel}>>  // camelCase!
        abilitySoulIds:    Array<Option<number>>
    }
    // 每个 character 额外需要 illustration_settings: Option<number[]>

    // 自动战斗设置
    autoplayMode: boolean
    autoskillMode?: number
    autoSpeedLevel?: number
    autoStart?: boolean
    skillAbilityBehaviorMode?: number
    dashBehaviorMode?: number

    // 状态
    state: ReadyState          // [0]=Preparation, [1]=Ready
    entryTime?: number
    isNewbie?: boolean
    allowHealFromOtherPlayers?: boolean
}
```

### 4.3 NPC 角色模板

```typescript
// 默认 NPC 数据（取自 CN 客户端 DummyRemote）
const NPC_TEMPLATES = {
    default_1: {
        com_id: 1,
        characters:     [131012, 141007, 151001],  // 阿尔克 斯特拉 莱特
        unison:         [141005, 121002, 131004],
        equipments:     [200005, 1010001, 2020001],
        rank: 80, degree_id: 1
    },
    default_2: {
        com_id: 2,
        characters:     [141004, 121002, 161001],
        unison:         [151001, 141005, 131004],
        equipments:     [200005, 1010001, 2020001],
        rank: 80, degree_id: 2000
    }
}
```

---

## 5. 关键字段命名对照

客户端 typepacker 反序列化时使用**源字段名**，必须精确匹配：

| 上下文 | 字段名 | 注意事项 |
|--------|--------|---------|
| summon → party.characters | `unison_characters` | snake_case ✅ |
| session → party | `unison_characters` | 同上，不得写 `unisonCharacters` |
| summon → party.equipments | `equipment_id`, `enhancement_level` | snake_case |
| session → party.equipments | `equipmentId`, `enhancementLevel` | **camelCase**！（session 路径不同） |
| summon → character | `mana_node_ids`, `ex_boost` | snake_case |
| session → character | `mana_node_ids`, `ex_boost` | 同上 |
| session → character | `illustration_settings` | 必需，`fixIllustrationSettingsForMate()` 会写出 |
| session → party | `abilitySoulIds` | camelCase ✅ |

---

## 6. 错误码对照

| 错误码 | 含义 | 根因 | 修复 |
|--------|------|------|------|
| `C8700` | `data.rooms[i].estabilisher_character:null` | MsgPack uint32 (`ce`) 编码 >65535 的值；`serializeRoom` 缺少该字段 | 使用 ≤65535 的 character ID；补全 `estabilisher_character` 字段 |
| `C5603` | `Handshake failure (TypeError #1034)` | 握手响应用 `{tag,index,__enum__}` 格式，但 `handshakeUnserializer.useEnumIndex=true` | 改用数组 `[0, roomId, ""]` |
| `C15202` | `matesに自分自身の情報が存在しません` | Welcome/Mates 的 `mates` 数组为空，不包含玩家自己 | mates 数组第一个元素为 `yourself` 对象 |
| `Error #1009` | Null Pointer in `fixIllustrationSettingsForMate()` | mate 对象 `party` 字段命名错误（`unisonCharacters` vs `unison_characters`），缺少 `illustration_settings` | 修正字段命名，补全 `illustration_settings: [1]` |
| `TypeError #1034` | Type coercion in `commandReceived()` | character/equipment 未用 Option `[0, val]` / `[1]` 格式包裹 | 所有 party 字段使用 Option 包裹 |
| `S1000` | `通信が終了されました` | TCP 连接意外关闭 | 正常关闭不处理 |
| `C8601` | `指定的Key不存在。key=2023013102` | 活动面板加载时，CDN master 数据缺少 `daily_challenge_point_campaign[2023013102]` | 通行证功能暂不实现，已清空所有角色 `daily_challenge_point_list`，默认存档不再写入该数据 |
| `C8601` | `key=0, ManaNodeTable` — 联机战斗玛那板 | `mana_node_ids` Array 格式触发 `getLearnedManaNodes()` 遍历 → `get_ability()` → CDN 查 key=0 | ✅ 已修复 — 改为 IntMap `{id:0}` 格式，详见 [§13](#13-联机玛那板-c8601-深度分析) |
| `H404` | `disband_room` 端点不存在 | 未实现该端点 | 已实现 `POST /multi_battle_quest/disband_room` |
| `H404` | `event/raid/summary` + 5 个 Raid 端点 | 未实现 | 已实现全部 7 个 Raid 端点（含 summary/ranking_reward/party/ranking/ranking:party/battle:start/get_boss），battle:start 为联机桩 |
| `H404` | `shop/bulk_buy` + `get_campaign_lineup_id` + `set_campaign_lineup_id` | 未实现 | 已实现桩 — bulk_buy 返回空，两个 campaign lineup 返回 stub |
| `H404` | `contents_guide/start` — 满玛纳板后引导弹窗 | 未实现 | 已实现 `POST /contents_guide/start`，返回 `{ data: {} }` |
| `H404` | `carnival_event/index` | 未实现 | 已实现 /index + /get_party |
| `H404` | `event/rush/reward` + `/endless_battle` | 未实现 | 已实现桩 — reward 返回空，endless_battle 返回初始状态 |
| `H400` | `ranking_event/get_summary` → 400（云水试炼等） | `rankingEventIdQuestMap` 缺少 CN 事件 ID 1000/1001 | 新增映射 `1000→1000001`, `1001→1001001` |
| `H500` | `shop/get_sales_list` → 500 | CN 导入的 shop 条目缺少 `availableUntil` 字段 | 已补充 `null` |
| `H400` | `character/receive_bond_token` → 400 — 玛纳板完成后领羁绊之证 | bond token status 残留为 2（上次 CN 导入期间领取），DB 重置后服务端拒绝 | ⚠️ 待排查 — DB 已重置为 1，暂不影响流程 |
| `C3032` | 抽卡动画稀有度不匹配（非必现） | 国际服种子池在国服物理配置下产生不同稀有度 | ⚠️ 已知不修复 — 详见 `docs/C3032_gacha_seeds.md` |
| `H400` | `story_quest/finish` → 400，外传故事/活动关卡 | 服务端 quest JSON 缺少 CN 事件组数据 | ✅ 已从 CN 源完全导入 20 个 quest 分类共 5,158 关 |
| `C8702` | `character_list[i].join_time:null` — mail 领取角色 | 邮件角色响应缺少 `join_time`/`update_time` 字段 | 已补齐 `clientSerializeDate` 格式 |
| `C8707` | `user_character_mana_node_list` 格式错误 | 序列化为数字数组，CN 客户端期望 `{ mana_node_multiplied_id: N }` 对象 | 已修正序列化格式 |
| `F1009` | TypeError #1009 — `ManaNodeTreeChartView/changeActiveManaBoard()` | `mana_board_index=2` 但 `mana_node.json` 缺少对应角色的 level 2 数据；或服务端时间早于 `mana_board2_open_condition` 的 `start_time` | ① 增量导入 CN 角色资产数据（含 level 2）② DB 重置 `mana_board_index=1` ③ 服务端时间调整到 2025-06-01 之后 |
| `F1010` | TypeError #1010 — 经验卡结算崩溃 | `bondTokenStatusList` 缺少 NPC/限时队伍条目，`null.before` | 所有队伍角色（含 DB 中找不到的）均创建条目 |

---

## 7. 已知限制

1. **MsgPack uint32 不兼容**: 值 >65535 会用 `ce` (uint32) 编码，客户端解码为 null。受影响的潜在字段：quest_id、rankPointReward、characterId 等。当前 workaround：关键 display 字段使用 ≤65535 的值。

2. **`disband_room`**: 已实现 HTTP 端点 `POST /multi_battle_quest/disband_room`，TCP `removeClient` 作为补充清理。

3. **单机模式**: 当前仅支持单人+NPC。真实多人联机需要：
   - 多个客户端连接到同一 room_number
   - 真实的 player mate 数据（从 DB 查询）
   - `attention` 匹配系统完善

4. **`HARD_MULTI_EVENT`**: quest 数据已导入，但 `getQuestFromCategorySync` 中 `fixedParty`、`scoreRewardGroup` 等字段可能缺失，战斗奖励可能不完整。

5. **TCP 消息合并**: 多消息在同一 TCP 段到达会导致客户端 commandReceived 解析失败（不分割 null 终止符）。当前通过延迟发送（800ms/1100ms）缓解。

6. **默认存档对齐**: 默认玩家数据的初始值已按 CN 客户端 `PlayerSaveDataTools.createDummy()` 对齐（vmoney=100, name=冒险者 等）。角色 ID 使用 business code，CN 客户端中阿尔克=1、白=10，k_id 映射表当前不需要。

7. **玛纳板（Mana Board）适配**: CN 角色的玛纳板二版受 `mana_board2_open_condition.json` 的时间窗口控制。CN 角色如 151165 的 `start_time=2025-04-03`，默认服务端时间 2024-08-14 早于此时间 → `canManaBoard2Open()` 返回 false → 仅显示板一。解决方法：将服务端时间调整到 2025-06-01 之后。

8. **EX Boost（增幅）感叹号**: 客户端 `canExBoost()` 不检查 `ex_boost` 字段（已强化状态），只检查角色满级 + 元素匹配 + 道具足够。即使 Tier 3 强化完毕，只要背包还有 EX 道具，感叹号就显示。属正常游戏行为。

9. **抽卡动画种子表（C3032）**: 详见 [`gacha-c3032.md`](./gacha-c3032.md) — 完整的前因后果、源码位置、修复路径

10. **联机战斗玛那板（C8601 key=0）—— 已确认无法修复**: 详见 [§13 联机玛那板 C8601 深度分析](#13-联机玛那板-c8601-深度分析)。联机战斗中所有角色（含房主自身）的 `mana_node_ids` **必须为 `[]`**，任何非空值都触发 C8601。官方游戏大概率也发送 `[]` 给 NPC，而房主的 party 在联机中走 `BattleCharacterLogic`（非 `OwnedCharacterLogic`），也受同一 bug 影响。

7. **外传故事 quest 数据**: 已从 CN 源 `wf-assets-cn/orderedmap/quest/` 完全导入全部 20 个 quest 分类，共 5,158 关，覆盖所有 CN 事件组。

### quest 数据导入详情

**源数据**: `wf-assets-cn/orderedmap/quest/*.json`
**目标**: `assets/*_quest.json`
**格式**: 扁平化 `{ questId: { fields } }`，`getQuestSync` 通过 `"manaReward" in quest` 自动区分剧情/BOSS 类型

**全部导入统计**:

| 文件 | 关数 | 剧情 | BOSS | CN格式 |
|------|:---:|:---:|:---:|------|
| main_quest.json | 419 | 419 | 0 | 3级嵌套 |
| ex_quest.json | 221 | 221 | 0 | 3级嵌套 |
| boss_battle_quest.json | 232 | 0 | 232 | 3级嵌套 |
| character_quest.json | 1,318 | 1,318 | 0 | 字典键 |
| advent_event_quest.json | 459 | 459 | 0 | 2级嵌套 |
| story_event_single_quest.json | 348 | 348 | 0 | 2级嵌套 |
| daily_week_event_quest.json | 114 | 114 | 0 | 2级嵌套 |
| ranking_event_single_quest.json | 7 | 7 | 0 | 2级嵌套 |
| challenge_dungeon_event_quest.json | 46 | 46 | 0 | 2级嵌套 |
| daily_exp_mana_event_quest.json | 6 | 6 | 0 | 2级嵌套 |
| world_story_event_quest.json | 913 | 841 | 72 | 2级嵌套 |
| world_story_event_boss_battle_quest.json | 96 | 0 | 96 | 2级嵌套 |
| tower_dungeon_event_quest.json | 480 | 480 | 0 | 2级嵌套 |
| expert_single_event_quest.json | 28 | 28 | 0 | 2级嵌套 |
| carnival_event_quest.json | 171 | 171 | 0 | 2级嵌套 |
| raid_event_quest.json | 50 | 50 | 0 | 2级嵌套 |
| rush_event_quest.json | 110 | 110 | 0 | 2级嵌套 |
| solo_time_attack_event_quest.json | 6 | 6 | 0 | 2级嵌套 |
| hard_multi_event_quest.json | 12 | 12 | 0 | 2级嵌套 |
| score_attack_event_quest.json | 123 | 60 | 63 | 2级嵌套 |
| **合计** | **5,158** | | | |

**CN 源格式说明**:
- **3级嵌套** (`main`, `ex`, `boss_battle`): `{ world: { stage: { node: [[quest_id,...]] } } }`
- **2级嵌套** (事件文件): `{ event_group: { chapter: [[quest_id,...]] } }`
- **字典键** (`character`): 顶层 key 即为 quest_id

**字段映射** (extract from CN array):
- `arr[0]` → quest_id
- `arr[4]` → clearRewardId
- `arr[85]-[88]` → rank times (seconds×1000→ms)
- `arr[94]-[97]` → battle rewards
- `arr[71]` → scoreRewardGroup

### 已实现的活动端点（非联机）

| 活动 | 端点 | 状态 | 说明 |
|------|------|:---:|------|
| 嘉年华 | `carnival_event/index` | ✅ | 返回 records+party |
| 嘉年华 | `carnival_event/get_party` | ✅ | 返回 party |
| Rush | `event/rush/reward` | ✅ 桩 | 返回空排名奖励 |
| Rush | `event/rush/endless_battle` | ✅ 桩 | 返回初始状态 |
| Raid | `event/raid/summary` | ✅ | Raid 主入口 |
| Raid | `event/raid/get_boss` | ✅ | BOSS 血量状态 |
| Raid | `event/raid/ranking_reward` | ✅ 桩 | 返回空奖励 |
| Raid | `event/raid/party` | ✅ | 返回 Raid 队伍组 |
| Raid | `event/raid/ranking` | ✅ 桩 | 返回空排名 |
| Raid | `event/raid/ranking/party` | ✅ 桩 | 返回空队伍数据 |

### 待完善（联机相关，Phase 2+）

| 端点 | 状态 | 依赖 |
|------|:---:|------|
| `event/raid/battle/start` | ⚠️ 桩 | 需要完整多人战斗流程（summon→start→finish） |
| `multi_battle_quest/summon` | ❌ | NPC mate 数据下发 |
| `multi_battle_quest/start` | ❌ | StartBattle 流程 |
| TCP Session Phase 2 | ❌ | NPC 加入房间 + 房主自动准备 + 完整战斗 |
| `attention/check` 匹配 | ❌ | 真实多人匹配（当前仅返回 config） |

---

## 8. 文件清单

| 文件 | 模块 | 职责 |
|------|------|------|
| `src/routes/api/multiBattleQuest.ts` | HTTP API | 14 个 REST 端点 |
| `src/data/multiRoom.ts` | 房间管理 | 房间 CRUD、NPC 生成、序列化 |
| `src/data/sessionServer.ts` | TCP 会话 (Phase 1) | 握手、心跳、Clean Room（无 NPC） |
| `src/lib/types.ts` | 类型 | `MultiRoom`, `MultiMate`, `MultiMateParty` 等 |
| `src/lib/assets.ts` | 资产 | `HARD_MULTI_EVENT` quest 查找 |
| `src/assets/hard_multi_event_quest.json` | 资产 | 12 个 hard_multi 关卡数据 |
| `src/cn-server.ts` | 入口 | 启动 sessionServer |
| `src/routes/api/singleBattleQuest.ts` | 公用 | `activeQuests` 导出供 multi 共用 |

---

## 9. 关卡/活动测试清单

详见 [`test-progress.md`](../status/test-progress.md) — 21 项关卡进入+结算双重测试进度。

---

## 9. 联机功能实现进度

### 9.1 阶段 1 — 创建房间 + TCP 握手 ✅

| 功能 | 状态 | 说明 |
|------|:---:|------|
| `get_rooms` | ✅ | 11 字段格式已对齐客户端 |
| `create_room` | ✅ | 房号生成、从 DB 读取 `leaderCharacterId` |
| `search_room` | ✅ | 按房号搜索 |
| `select_room` | ✅ | 返回 TCP 会话 IP:8003；房间不存在→raising_state=9 |
| `prepare` | ✅ | 同上 |
| TCP server (port 8003) | ✅ | XMLSocket null-terminated JSON |
| 握手 Accept | ✅ | typepacker `[0, roomId, ""]` |
| Welcome + Mates | ✅ | `[1,[0,yourself,[yourself]]]` + `[1,[1,[yourself]]]` |
| Heartbeat/AckHeartbeat | ✅ | 5 秒间隔 |
| Bye → disbandRoom | ✅ | 最后客户端断开→删除房间 |
| `restore_room` | ✅ | 断线恢复，房间不存在→raising_state=9 |
| `share_room` | ✅ | 桩 |
| `verify_access_token` | ✅ | 桩 |
| `publish_room` | ✅ | CN 微社区分享，返回 `{}` |
| `attention/action` | ✅ | 桩，返回 `{priority_action_score:0, priority_playing_score:0}` |
| `attention/logger` | ✅ | 桩，返回 `{}` |

### 9.2 阶段 2 — NPC 加入 + 自动连战 ✅

| 功能 | 状态 | 说明 |
|------|:---:|------|
| `summon` NPC mate 数据 | ✅ | HTTP 下发 mate1/mate2 |
| NPC 加入房间（EnterComs） | ✅ | Mates 更新为 [host, NPC1, NPC2] |
| NPC 自动 Ready | ✅ | NPC_READY_DELAY_MS 后各自 StateChanged(Ready) |
| 房主准备倒计时 | ✅ | NPC_HOST_READY_COUNTDOWN_MS 延迟后 auto-ready |
| `StartBattle → Start(members)` | ✅ | members 含完整 mate 对象数组 |
| 战斗结算后返回房间 | ✅ | finish→raising_state=1，room TCP 存活→可再战 |
| 房间断线恢复 | ✅ | TCP 断线→disband，restore_room 返回 9 |
| 自动招募 NPC（进入房间时） | ✅ | NPC_AUTO_JOIN_DELAY_MS 后自动 EnterComs |
| 战斗协议完善 | ✅ | SceneReady(tag=0)+Finalize(tag=1)+Measurement(tag=2) |

### 9.3 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SESSION_PORT` | 8003 | TCP 会话端口 |
| `SESSION_HOST` | 0.0.0.0 | TCP 绑定地址 |
| `MULTI_ROOM_EXPIRY_MS` | 600000 | 空闲房间过期（ms），默认 10min |
| `MULTI_BATTLE_ROOM_EXPIRY_MS` | 600000 | 战斗中房间无活动过期（ms），默认 10min |
| `MULTI_ROOM_CLEAN_INTERVAL_MS` | 60000 | 过期检查间隔（ms） |
| `QUEST_RESULT_DISBAND_DELAY_MS` | 60000 | 结算后返回房间等待窗口（ms），对齐 CDN `room_config.json` |
| `NPC_JOIN_DELAY_MS` | 2000 | NPC 加入房间延迟（ms） |
| `NPC_READY_DELAY_MS` | 500 | NPC 准备延迟（ms） |
| `NPC_HOST_READY_COUNTDOWN_MS` | 3000 | 房主准备倒计时（ms），0=立即准备 |

### 9.4 房间完整生命周期

```
create_room → state=2 (Waiting: 房主未进TCP)
  ↓ 房主 prepare/select_room → host override → state=1
  ↓ 客端 prepare/select_room → state=2 → 轮询等待（未来联机）
TCP handshake → updateRoomState(1) （幂等确保）
  ↓
state=1 (Ready: 可加入/可招募)
  ├─ 点[随机招募] → is_npc_mode=true → EnterComs → state=3 (Filled)
  │     ↓
  │   NPC Ready → 房主倒计时 → start → state=4 (Battle)
  │     ↓
  │   finish → state=1, 删 ActiveQuest → battle TCP 断开
  │     ├─ 60s 内 prepare/select_room → 新 TCP → 取消定时器 → 回到 state=1
  │     └─ 60s 无人 → disband
  │     ↓
  │   abort → disbandRoom, 删 ActiveQuest
  │
  ├─ 不招募 → is_npc_mode=false → 等待
  │
  └─ TCP 断线（非 battle）→ disbandRoom
```

**状态变更矩阵：**

| 触发操作 | 条件 | 从 | 到 |
|------|------|:---:|:---:|
| `create_room` | — | — | 2 |
| TCP handshake | — | 2 | 1（幂等） |
| `select_room`/`prepare` | host | 2 | 返回 1（override） |
| `select_room`/`prepare` | guest | 2 | 返回 2（真实值） |
| `start` | — | 1 | 4 |
| `finish` | host | 4 | 1 |
| `abort` | host | 4 | disband |
| `disband_room` | — | any | disband |
| TCP 断线 | isBattle + state=1 | 1 | 60s 后 disband |
| TCP 断线 | isBattle + state=4 | 4 | 保留（过期清理） |
| TCP 断线 | !isBattle | 1/2 | disband |
| 空闲过期 | 10min + state≤3 | 1/2/3 | disband |
| 战斗过期 | 10min + state=4 | 4 | disband |

**raising_state 完整枚举：**

| 值 | 名称 | 使用 | 说明 |
|:---:|------|:---:|------|
| 1 | Ready | ✅ | 可加入/招募 |
| 2 | Waiting | ✅ | 房主未进 TCP |
| 3 | Filled | ✅ | NPC 加入后满员 |
| 4 | Battle | ✅ | 战斗中 |
| 7-13 | — | — | 多人联机时使用 |

### 9.5 已知桩值/假值

| 位置 | 值 | 说明 |
|------|------|------|
| `sessionServer.ts` | NPC viewerId `900000001/2` | 虚拟 ID，仅用于结算验证 |
| `sessionServer.ts` | NPC `playerRoleKind: 99` | NPC 标识 |
| `attention.ts` `/action` | `priority_action_score: 0` | NPC 模式桩，无人匹配 |
| `attention.ts` `/logger` | `data: {}` | 丢弃日志 |
| `attention.ts` `/check` | 静态 config | 硬编码，未来应从 CDN 读取 |
| `multiBattleQuest.ts` `/micro_community` | `micro_community_list: []` | CN 桩 |
| `multiBattleQuest.ts` `/publish_room` | `data: {}` | CN 桩 |

### 9.6 战斗协议

| 消息 | 通道 | 服务端处理 |
|------|------|------|
| `BattleNotifyMessage.SceneReady(0)` | Notify | → `BattleStart(1)` |
| `BattleNotifyMessage.Finalize(1)` | Notify | → `Finalized(2)` |
| `BattleNotifyMessage.Measurement(2)` | Notify | → 回显 `Measurement(3)` |
| `BattleNotifyMessage.Heartbeat(4)` | Notify | → 回显 `Measurement(3)` |
| `BattleSocketCommand.Heartbeat(2)` | Broadcast/Send | → 回显 `Measurement(3)` |

### 9.7 战斗恢复数据层（Phase 3 基础）

| 功能 | 状态 | 说明 |
|------|:---:|------|
| DB 表 `players_active_quests` | ✅ | 持久化 active quest |
| `play_id` / `continue_count` 追踪 | ✅ | start 写入，play_continue 递增 |
| `/load` 返回 `unfinished_quest_list` | ✅ | 客户端启动时检测未完成战斗 |
| `unfinished_multi_quest_list` | ✅ | 多人战斗独立列表 |

### 9.7.5 真人联机 Phase 1-3 ✅

| 功能 | 状态 | 说明 |
|------|:---:|------|
| `broadcastToRoom()` | ✅ | 消息广播给房间所有客户端 |
| `relayToBattleRoom()` | ✅ | 战斗帧命令中继 |
| Guest Enter 通知 | ✅ | 新玩家加入时广播 Mates 给已有客户端 |
| Ready 广播 | ✅ | StateChanged 发给所有客户端 |
| ChangeParty 广播 | ✅ | 队伍变更通知 |
| StartBattle 广播 | ✅ | Start(members) 发给所有客户端 |
| 房主自动准备 | ✅ | `checkHostAutoReady`: 全员 Ready→房主 Ready, 新人加入→取消 |
| SceneReady 全员等待 | ✅ | 所有 battle client SceneReady 后才广播 BattleStart |
| Battle TCP 握手注册 | ✅ | `cidToBattleClient` + `battleExpectedCount` |
| `get_rooms` 可见性 | ✅ | `host_viewer_id === viewerId` 过滤 |
| `search_room` 类型修复 | ✅ | `establisher_follow: false→0` |
| 战斗帧同步 | ⚠️ | 帧命令 relay 已实现，但客户端还未真正同步战斗 |

### 9.8 已知限制

| 问题 | 状态 | 说明 |
|------|:---:|------|
| C8700 stale room | ✅ 已修复 | `hasRoomClients` 过滤 + 60s return window 清理 |
| 消息 TCP 合并 | ⚠️ | 100ms/200ms 延迟规避 |
| `get_rooms` 返回无 TCP 客户端的房间 | ✅ 已修复 | `hasRoomClients` 防御过滤 |
| 战斗恢复 UI（RestoreState.Battle） | 待测 | DB 层已就绪，客户端恢复弹窗流程待验证 |

---

## 11. wdfpData.ts 重构完成 ✅

### 11.1 最终状态

`src/data/wdfpData.ts`: **4813 → 54 行 (-98.9%)**，纯 barrel re-export 文件。

16 个领域模块全部通过 barrel 导出，所有旧 `import ... from "wdfpData"` 路径自动生效。

### 11.2 各模块提取记录

| 步骤 | 模块 | 文件 | 函数数 | 提交 |
|:---:|------|------|:---:|------|
| 1 | Account + Session | `account.ts` | 12 | `cefa243` |
| 2 | Tutorial | `tutorial.ts` | 3 | `cefa243` |
| 3 | PlayerOption | `option.ts` | 5 | `5c073f1` |
| 4 | PlayerItem | `item.ts` | 6 | `5c073f1` |
| 5 | Campaign ×3 | `campaign.ts` | 9 | `5c073f1` |
| 6 | PlayerEquipment | `equipment.ts` | 8 | `7bba7c0` |
| 7 | PlayerParty | `party.ts` | 6 | `3ed5962` |
| 8 | PlayerCharacter | `character.ts` | 17 | `828fd8a` |
| 9 | Quest + DrawnQuest | `quest.ts` | 9 | `828fd8a` |
| 10 | Gacha | `gacha.ts` | 12 | `fa85420` |
| 11 | Mission | `mission.ts` | 7 | `f885c2b` |
| 12 | BoxGacha | `boxGacha.ts` | 9 | `618cc4e` |
| 13 | RushEvent | `rushEvent.ts` | 22 | `5adea1c` |
| 14 | Mail | `mail.ts` | 9 | `f63e05d` |
| 15 | Session + Device | `session.ts` | 15 | `3c65cb9` |
| 16 | Player CRUD + DCPL | `player.ts` | 20 | `3c65cb9` |

**总计**: 16 个领域文件，169 个函数，0 TypeScript 错误。

---

## 12. CDN 资产下载系统

### 12.1 端点

| 端点 | 说明 |
|------|------|
| `asset/version_info` | 返回 CDN 基础信息（base_url, total_size） |
| `asset/get_path` | 返回全量包列表 + 差分包链 + 版本信息 |

### 12.2 全量/部分下载逻辑（源码：`AneAssetDownloading.startDownload()`）

客户端通过 `ASSET_SIZE` 头区分模式：

| 模式 | `ASSET_SIZE` | `full` 返回 | 下载内容 |
|------|:---:|------|------|
| **全部下载** | `fulfill` | `Some({ version, archive })` | 本体（full.archive）+ diff 链 |
| **部分下载**（有本地资产） | `shortened` + `RES_VER` 存在 | `null` | 纯 diff 链（从本地版本出发） |
| **部分下载**（无本地资产） | `shortened` + `RES_VER` 不存在 | `Some({ version, archive })` | 退化为全部下载 |

### 12.3 diff 链遍历算法

```typescript
// 客户端下载列表构建
archiveList = full.archive                       // 全部下载: 实际文件 | 部分下载: []

// diff 索引 (key = original_version)
diffIndex.set(diff.original_version, diff)

// 链式遍历
version = full.version
while (diffIndex.has(version)) {
    archiveList.concat(diffIndex.get(version).archive)
    version = diffIndex.get(version).version       // 跳到下一版本
}
// 1.4.0 → 1.4.1 → 1.4.2 → ... → 1.4.54
```

### 12.4 `is_initial` 判断

```typescript
is_initial = !resVer  // 无 RES_VER 头 = 首次下载 = 弹出模式选择
```

首次下载：`is_initial=true` → 客户端翻转模式发起双请求 → 弹出"全量/部分下载"按钮
后续下载：`is_initial=false` → 直接按当前模式下载

### 12.5 `files_list` 校验规避

`version_info` 响应的 `files_list` 返回空字符串 `""`。客户端 `AssetSufficiencyCheckLoading` 要求该字段为 String（否则 C8702），但空字符串意味着跳过所有文件完整性校验。

### 12.6 `total_size` 计算

```typescript
// FULL_SIZE = 仅全量包文件（archive-*-full/ 目录）
// TOTAL_SIZE = FULL_SIZE + 全部差分包（用于显示）
// version_info 使用 FULL_SIZE 作为下载大小预估
```

### 12.7 CDN 目录结构

```
.cdn/cn/
├── archive-common-full/    ← 全量包（1.4.0, ~100 文件 × 20MB）
├── archive-medium-full/    ← 全量包
├── archive-android-full/   ← 全量包
├── archive-common-diff/    ← 差分包（1.4.0→1.4.54, 79 个真实文件）
├── archive-medium-diff/    ← 差分包（111B 空壳占位）
├── archive-android-diff/   ← 差分包（111B 空壳占位）
└── EntityLists/
```

### 12.8 相关错误码

| 错误 | 含义 | 原因 |
|------|------|------|
| C8601 | Key 不存在 | CDN 资源版本不匹配 |
| C8702 | `data.files_list:null` | `files_list` 字段缺失（必须为 String） |
| ClientError 20100 | Asset initial version not found | `full=null` 且本地无 info.json |
| "Full Asset 不存在" | 响应缺少 full 字段 | `full=null` 且 `initialVersion=None` |

---

## 13. 联机玛那板 C8601 深度分析

### 13.1 现象

联机战斗中，**服务端 `buildRealParty()` 构造的** party 数据中 `mana_node_ids` 必须为 `[]`。任何非空值触发 C8601：

```
ERR:C8601|指定的Key不存在。key=0, app-storage:/asset/.../upload/1d/222e5126...
```

**关键突破（2026-06-18）**：客户端 relay 模式（`OwnedCharacterLogic` 序列化的 party）传入的 `mana_node_ids` **不触发 C8601**。详见 §13.5。

### 13.2 崩溃堆栈

```
MasterBinaryMap.getIndex(key=0)
  → MasterMapBase.get(0)
    → GeneralManaNodeLogic.get_values()
      → get_kind()
        → _getAbility()
          → get_ability()
            → GeneralCharacterLogic/getAwakeLevelByManaNodes  ← 内联函数
              → _getActionSkillEvolution()
                → get_actionSkillEvolution()
                  → resolvePathCollection()
```

`getAwakeLevelByManaNodes` 存在于运行时堆栈中但**不存在于任何 `.as` 或 `.pcode` 文件**——Haxe 编译器内联。

### 13.3 根因——`mana_node_ids` Array vs IntMap 格式（已确认 2026-06-18）

**`mana_node_ids` 的数据格式决定是否触发 C8601。**

客户端 `OwnedCharacterLogic.getBattleCharacter()` 输出 `mana_node_ids` 为 **IntMap** 格式：
```json
{"2201": 0, "2207": 0, "2208": 0}      // IntMap {multiplied_id: awake_level}
```

服务端 `buildRealParty()` 之前输出为 **Array** 格式：
```json
[2201, 2207, 2208]                       // Array 数字数组
```

`getLearnedManaNodes()` 通过 `.length` 判断是否遍历：
- **IntMap** `{}` → `.length = undefined → int(undefined) = 0 → 跳过循环 → 不调 `get_ability()` → ❌ 不崩**
- **Array** `[2201,...]` → `.length = 6 → 遍历 → 逐元素调 `get_ability()` → `get_values()` → CDN 查 `characterId=0` → ✅ 崩**

**修复**：`buildRealParty()` 将 `mana_node_ids` 从 `number[]` 改为 IntMap `{multiplied_id: 0}`，对齐客户端序列化格式。

**AB 确认测试（同一角色 Alk id=1，已解锁 6 个节点）**：

| 测试 | 格式 | SceneReady | C8601 |
|------|------|:---:|:---:|
| 修复前 (Array) | `[2201,2207,2208,2209,2212,2210]` | ❌ | ✅ 崩溃 |
| 修复后 (IntMap) | `{"2201":0,"2207":0,"2208":0,"2209":0,"2210":0,"2212":0}` | ✅ | ❌ 不崩 |

**NPC 独立配队 + 真实 mana_node_ids → 联机战斗成功！**

### 13.4 CDN 表确认

| 表 | JSON 条目数 | Key 范围 | key=0 存在？ |
|------|:---:|------|:---:|
| `mana_node.json` | 495 | 1 ~ 999999 | ❌ |
| `character.json` | 505 | 1 ~ 999999 | ❌ |

崩溃时访问的 CDN 文件 `1d/222e5126fc7ebe3f22c7efe87325f73742eb4f` 遍历未匹配任何已知表名。

### 13.5 官方 relay 模式突破（AB 对照确认）

**官方流程**：服务端只做 TCP 中转，不构造 party。房主客户端 `getMate()` → `getBattleParty()` → `OwnedCharacterLogic.getBattleCharacter()` 序列化后发 Enter，服务端 relay 到 Welcome。

**私服 relay 模式**（已实施）：握手后**不立即发 Welcome**，等待客户端 Enter → 提取 `ed.party` → 放入 Welcome/Mates。

**AB 测试**：

| 测试 | 房主 party | NPC party | 结果 |
|------|----------|-----------|:---:|
| A | relay (客户端 Enter) | hostParty 回退 | ✅ 成功，玛那板生效 |
| B | relay (客户端 Enter) | `buildRealParty()` 独立配队 | ❌ C8601 |

栈追踪确认：`GeneralCharacterLogic/getAwakeLevelByManaNodes` → `get_values()` → `getIndex(0)`。

### 13.6 修复方向状态

| 方向 | 结果 |
|------|------|
| **IntMap 格式修复（将 Array 改为 `{id:0}` 对象）** | ✅ **已修复，NPC 独立配队联机战斗成功** |
| relay 模式（客户端 party 中转） | ✅ 房主玛那板生效；本质也是 IntMap 格式 |
| CDN ManaNodeTable 加 key=0 dummy | ❌ 无需（根因是格式，非 CDN 缺失） |
| 战斗协议注入 | ❌ 战斗 TCP 协议无角色能力消息 |
| APK 补丁分析 | ✅ 确认补丁不涉及玛那板逻辑 |
| `buildDefaultParty()` id=0 | ✅ 防御性修复 |
| 纯服务端缓存注入 | ❌ 无对应机制 |

### 13.7 房间入口路径与 relay 时序

所有进入联机房间的方式最终汇聚到同一代码路径：

```
开房 (create_room)         ┐
房间号加入 (search_room)    │
邀请令牌加入 (verify_token) │
关注/活动加入               ├──→ LoadingTaskKind.EnterCooprationRoom
App恢复房间 (restore_room)  │         ↓
战斗结算回房                │    SocketConnectionTask
房间断线重连                ┘         ↓
                                EnterRoomService.run()
                                      ↓
                                 TCP 握手 → socketInput_ready()
                                      ↓
                                 PlayerLogic.getMate()
                                      ↓
                                 getBattleParty() → getBattleCharacter()
                                      ↓
                                 { mana_node_ids: abilities, ... }
```

**没有第二条路径。** `CooperationRoomConnectionReason` 的 `Select`（新建）和 `Resume`（恢复）在发 party 数据时行为完全一致——都调用 `getMate()`，都携带 `mana_node_ids`。

### 13.8 `misc_data` 与房间恢复的关系

`misc_data` 的 `partyForEachQuest` 已知会残留旧 session 的队伍选择（导致 C2337），但它**不存储房间恢复数据**。`RestoreState.CooperationRoom` 由 `GlobalLoadingTask.processRestoreState`（case 4）触发，仅在客户端闪退后应用重新启动时生效，不影响正常新建/加入流程。

### 13.9 相关代码位置

| 文件 | 行 | 说明 |
|------|:---|------|
| `sessionServer.ts` | 453-478 | `buildRealParty()` — mana_node_ids 数据源 |
| `sessionServer.ts` | 440-451 | `buildDefaultParty()` — id=0 潜在崩溃 |
| `sessionServer.ts` | 589-601 | 房主 party 构造流程 |
| `sessionServer.ts` | 634-640 | Welcome/Mates 消息发送 |
| `GeneralCharacterLogic.as` | 79-103 | 构造函数 — `CharacterTable.get(id)` |
| `GeneralCharacterLogic.as` | 376-427 | `getPlusValueByManaNodes` — 缓存逻辑 |
| `GeneralManaNodeLogic.as` | 102-121 | `get_values()` — C8601 触发点 |
| `BattleCharacterLogic.as` | 77-93 | 构造函数 — `abilities = param1.mana_node_ids` |
| `BattleCharacterLogic.as` | 1326-1339 | `getLearnedManaNodes()` — 构造 ManaNodeLogic |
| `BattleCharacterLogic.as` | 732-734 | `get_actionSkillEvolution()` — 入口 |
| `BattlePartyLogic.as` | 344-423 | `getUnitedCharacterPeeks` — 创建 BattleCharacterLogic |
| `MasterBinaryMap.as` | 63-76 | `getIndex()` — C8601 抛出点 |
| `BattleServerMessage.as` | 1-50 | 战斗协议 — 无角色能力消息 |
| `RestoreState.as` | 49-51 | `CooperationRoom` — 闪退恢复状态 |
| `GlobalLoadingTask.as` | 317-334 | `restoreRoomRemoteInput` → Resume |
| `GlobalLoadingTask.as` | 432-466 | `processRestoreState` — 恢复路由 |
| `CooperationRoomConnectionReason.as` | 1-35 | Select/Resume 枚举 |
| `EnterRoomService.as` | 136-176 | `socketInput_ready` — 发送 mate party |
| `PlayerLogic.as` | 1379-1401 | `getMate()` — 构造 mate 数据 |
| `CooperationRoomSocketContact.as` | 249-264 | `startBattle` — 传递 continuationData |
| `MultiQuestStartLoadingTask.as` | 116-204 | `run()` — 找自己 party + 发 quest_start |
| `MultiQuestStartLoadingTask.as` | 252-264 | `remoteFinishedHandler` → BattleSource 创建 |

### 13.8 relay 模式详解

**时序**：

```
旧模式（已弃用）:
  握手 → Accept → 立即发 Welcome (buildRealParty构造) → 客户端 Enter → 丢弃

新模式（relay）:
  握手 → Accept → 等客户端 Enter → 提取 ed.party → 发 Welcome (客户端 party 中转)
```

**实现位置** (`sessionServer.ts`):

| 行 | 改动 |
|:---|------|
| 563 | `yourself` 存入 `client.yourself`，不立即发 Welcome |
| 148-168 | `case 0` (Enter)：`yours.party = ed.party` → 发 Welcome + Mates |

**NPC 回退机制**：

当 `handleEnterComs()` 找不到 DB 中的 NPC 配队（`npcParties=0`）时：
```typescript
const party = npcParties[i] ?? (npcParties[0] ?? hostParty)
```
NPC 继承 hostParty（此时已是 relay 数据），玛那板同样生效。NPC 独立配队需 `buildRealParty()` → 触发 C8601。

### 13.9 最终解决方案（IntMap 格式）

**问题**：`buildRealParty()` 输出 `mana_node_ids: [2201, 2207, ...]` (Array)

**修复** (`sessionServer.ts:490-493`)：
```typescript
const rawNodes = getPlayerCharacterManaNodesSync(playerId, charId)
const manaNodeMap: Record<string, number> = {}
for (const id of rawNodes) manaNodeMap[String(id)] = 0
// 输出: mana_node_ids: {"2201": 0, "2207": 0, ...}
```

**客户端 AB 确认**（日志 `[RELAY-DIFF]` vs `[BUILD-DIFF]`）：
- relay 数据（客户端 OwnedCharacterLogic）：`{"2201": 0, ...}` IntMap
- buildRealParty（修复后）：`{"2201": 0, ...}` IntMap → 格式一致 ✅

**NPC 独立配队 + 真实 mana_node_ids → 联机战斗 SceneReady → 无 C8601 ✅**

### 13.10 relay vs buildRealParty 排查（已完成）

### 13.10 相关代码位置
