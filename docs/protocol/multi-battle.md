# 多人联机协议

本文描述 `src/multi/` 当前实际实现的多人联机协议、状态边界和持久化职责。协议依据以 CN 1.8.1 客户端反编译、当前注册源码和自动测试为准；当前树不收录原始抓包。

## 1. 当前支持边界

当前可以使用的主流程：

- 房主创建房间、选择房间并连接 lobby TCP；
- 房主招募 NPC、准备、开始战斗和提交结算；
- lobby 内的 Welcome、Mates、Ready、Start 和心跳；
- battle TCP 的 SceneReady 屏障和普通 Broadcast/Send 中继；
- 超级猫头鹰 BothBoss 的 LevelNext、第二代 SceneReady 和最终 Finalize；
- `embedded`、可信 LAN/VPN `host`、`client` 三种运行模式，以及三独立进程的服务端集成验证；
- 多人 active quest 写入 SQLite，并在 `/load` 中返回未完成关卡；
- 全部剩余真人 Finalize 后由 coordinator 权威释放当局，并把现有房间恢复到可重赛状态；
- 房间级随机 access token、房主权限和断线成员恢复边界；
- NPC 昵称从项目维护的昵称池分配，并在房间生命周期内保持稳定。

当前不完整或缺失的能力：

- 真人随机匹配和完整的双客户端真机流程；
- 多场景进程重启恢复和客户端完整异常链；
- 进程重启后的房间和 TCP 会话恢复；
- 真人成员、重赛、昵称显示和 TCP 中断的完整客户端回归矩阵。

基础 NPC 房主流程已有实际使用。自动测试覆盖服务端状态机，但不能替代 CN 客户端验收。

## 2. 组件与数据边界

默认 `embedded` 把游戏 HTTP、Coordinator 和 TCP 放在同一服务进程中，普通用户无需额外配置。可选 `host` 在自身 `8001` 游戏 HTTP 外提供 `8003` Hub TCP 和 `8004` Hub control；`client` 只保留自己的 `8001`，通过 `8004` 控制房间，游戏客户端按房间响应直连 Host `8003`。三种模式都保持玩家 SQLite 与结算在所属服务端本地。

Hub 不代理游戏主 API、CDN 或后台，也不自动对齐资源与服务器时间。多人协议版本、`APP_VER`、多人战斗内容摘要或 Mod 摘要不兼容时，`search_room`/`verify_access_token` 映射为 `4020` NotPlayable，`select_room` 返回 `raising_state=7`，`prepare` 返回 `4507`；`RES_VER` 与 CDN 目标版本参与比较，但不记录为拒绝，也不单独阻断同房。只有真实缺房才使用 `room_exists=false` 或 `raising_state=9`。

多人联机由八类组件组成：

| 组件 | 位置 | 职责 |
|---|---|---|
| HTTP 路由 | `src/multi/http/` | 建房、选房、招募、开始、结算、放弃和兼容响应 |
| TCP 协议 | `src/multi/tcp/` | 握手、lobby 消息、battle 消息和帧中继 |
| 房间管理 | `src/multi/room/` | 进程内房间、状态、过期清理和响应序列化 |
| 会话状态 | `src/multi/state/` | lobby/battle socket、连接索引、准备状态和 SceneReady 屏障 |
| NPC 提供方 | `src/multi/npc/` | NPC 模板、昵称、房间 roster 和招募结果 |
| 玩家上下文 | `src/multi/player-context.ts` | 从 viewer session 解析账号、存档和玩家 |
| 玩家快照 | `src/multi/snapshot/` | 一次读取 NORMAL/EVENT 编队组，选择目标与 NPC 编队后按去重 ID 批量读取角色、玛纳节点和装备，并生成冻结 session party |
| 结算编排 | `src/multi/settlement/` | 事务外授权、单事务奖励与任务结算、finish 响应投影 |

房间与 TCP 会话只保存在 Node.js 进程内：

- `room/manager.ts` 保存 room number、随机 access token、房主、复合身份成员资格、成员摘要和 `raising_state`；
- `SessionManager` 保存 lobby client、battle client、connection ID 和 SceneReady 状态；
- 服务进程停止后，这些结构全部消失，不尝试恢复。

玩家 active quest 属于持久数据：

- `/start` 写入 `players_active_quests`；
- `/finish` 或 `/abort` 清理 active quest；
- 进程重启或客户端重新登录后，即使 active quest 仍在，原战斗场景和 TCP socket 也无法恢复；
- 国服客户端把战斗中的 `raising_state=4` 映射为“房间已开始”，没有消费服务端战斗快照的续接路径。因此 `/load` 对具有完整多人战斗身份的残留记录执行既有中止退款事务，不再发布会循环失败的 `unfinished_multi_quest_list`；
- 身份字段非法或旧 client 记录缺少战斗身份时继续 fail closed，不把未经验证的数据猜测为可退款战斗。

同一客户端进程内的 HTTP finish 重试仍可使用 active quest 和 Hub retained fact；跨客户端重启不承诺恢复已经开始的多人战斗。

## 3. HTTP 与 TCP 编码

### 3.1 游戏 HTTP API

多人 HTTP 路由挂载在：

```text
/api/index.php/multi_battle_quest/*
```

它们沿用游戏主 API 管线：

- 请求体通常为 `base64(msgpack(object))`；
- 请求 Content-Type 为 `application/x-www-form-urlencoded`；
- Fastify parser 解开 Base64 与 MsgPack；
- 响应对象由 MsgPack onSend hook 编码；
- 响应 Content-Type 为 `application/x-msgpack`。

HTTP MsgPack 与多人 TCP Typepacker 是两套协议，不得互换编码器。

### 3.2 多人 TCP

TCP session 默认监听 `SESSION_PORT=8003`，绑定地址由 `SESSION_HOST` 控制。服务端告知客户端的可达地址遵循[网络支持边界](../getting-started/network-boundary.md)。

TCP 传输格式为：

```text
JSON.stringify(message) + "\0"
```

每条消息使用空字符分帧。握手后的枚举按 Typepacker `useEnumIndex=true` 表示为数组：

```text
[enumIndex, param1, param2, ...]
```

这不是 MsgPack，也不是带 `tag`、`index` 或 `__enum__` 字段的对象。

TCP 入口带有连接级资源护栏：首个握手帧默认必须在 15 秒内到达，单帧默认不超过
256 KiB，未完成帧的累计接收缓冲默认不超过 1 MiB。服务端启用 TCP NoDelay 与
keepalive；发送方向每个 socket 单独排队，默认最多缓存 512 条或 4 MiB，持续背压
超过 15 秒只关闭该慢连接，不阻塞同房间其他玩家。上述默认值可以通过 `.env` 中的
`SESSION_*` 与 `MULTI_SEND_QUEUE_*` 参数调整，调整应配合协议回归测试，不改变消息
编码或房间权威归属。

多人传输、战斗租约、房间清理和 NPC 招募参数统一由启动时解析并冻结的
`RuntimeConfig.multiTuning` 提供。`MultiRuntimeService` 把同一份快照注入 Embedded、
Host 和 Client 本地 fallback TCP，底层模块运行中不重新读取 `.env`。`startSessionServer()`
只为测试或低层调试保留显式覆盖：`handshakeTimeoutMs`、`maxFrameBytes`、
`maxBufferBytes` 和 `keepAliveInitialDelayMs` 四个标量可以独立覆盖 `transportTuning`
中的对应字段；发送队列和 battle 租约则分别通过完整的 `transportTuning`、`battleTuning`
对象注入。受支持的生产启动路径仍统一经过 `src/multi/runtime/session-options.ts`，把网络
配置、调优快照、可选 Host 服务和 fatal 回调映射为 `SessionServerOptions`。

### 3.3 Battle 连接安全租约

服务端把 battle socket 分为两个阶段：握手成功后等待 `SceneReady` 的 loading 阶段，
以及收到 `SceneReady` 后的 active 阶段。loading 默认 60 秒没有完成 `SceneReady` 就
关闭该 socket；active 默认 25 秒没有收到任何 battle 业务帧就关闭该 socket。Heartbeat
（Notify 索引 5）会刷新 active 活动时间，但沿用当前 CN 行为不额外回包；其他 battle
帧也会刷新活动时间。租约是服务端资源保护，不宣称为官方客户端倒计时。断开仍走现有
Leave、SceneReady 屏障和 battle fact 清理路径；重连保留窗口和 NPC 补位不在本节实现。

部署者可以通过 `BATTLE_LOADING_LEASE_MS` 与 `BATTLE_HEARTBEAT_LEASE_MS` 调整默认值，
调整前应运行双服协议回归。

每次连接布置或重置 battle timer 都形成新的 timer generation。超时回调只有在自己仍是
该 connection ID 当前登记的 timer，且 client 仍是该 connection ID 当前连接时，才拥有
清理和关闭连接的权利；连接被替换、租约被重置或 timer 被清除后，旧回调即使随后执行，
也不能删除新 timer 或关闭替换后的连接。

Session TCP 在正常 `stop`、fatal teardown 和 startup failure 路径都会把可靠发送与 battle
租约调优恢复为默认值，后续 server generation 不继承前一代的临时状态。这些配置与
生命周期防护只约束服务端资源使用，不改变 Typepacker 消息、Heartbeat 行为、房间状态或
既有断线处理等协议语义。

## 4. HTTP 路由族

当前插件共注册 16 个多人 HTTP 路由，按职责分为四组。

### 4.1 房间发现与选择

| 路由 | 当前职责 |
|---|---|
| `get_rooms` | 真人随机匹配未实现时返回合法空列表，不把自己的房间伪装成匹配结果 |
| `create_room` | 校验玩家与关卡，创建进程内房间、room number 和房间级随机 access token |
| `search_room` | 按 room number 返回房间是否存在及基础房主信息 |
| `select_room` | 返回 TCP 地址、端口和房间状态；房间缺失时返回状态 9 |

### 4.2 准备、招募与解散

| 路由 | 当前职责 |
|---|---|
| `prepare` | 校验 viewer session、房间和关卡后返回 TCP 连接信息；这是首次加入前入口，不要求已有成员资格 |
| `summon` | 仅房主可请求静态 NPC mate 模板 |
| `restore_room` | 已记录成员可恢复仍在进程内的房间；陌生玩家返回状态 13，缺失房间返回状态 9 |
| `share_room` | 仅房主可提交，成功响应不含业务字段，也不提供真实分享或匹配队列 |
| `disband_room` | 房间存在时仅房主可广播 Disbanded 并删除房间；房间已不存在时幂等成功 |

### 4.3 战斗生命周期

| 路由 | 当前职责 |
|---|---|
| `start` | 重新校验请求节点与房间固定兼容性、玩家成员身份及关卡一致性；兼容性校验在任何本地扣费或 active quest 写入前完成。每位真人分别写入 active quest，仅房主预扣体力和 Always 门票；`raising_state=4` 已由 TCP StartBattle 建立 |
| `finish` | 由 Hub 授权 retained completion fact，再按 `play_id + category + quest_id` 校验多人 active quest，并拒绝负 Mana、非法分数/耗时、continue 次数或 Boost 余额不一致；各节点只结算自己的存档，全部剩余真人 Finalize 后由 coordinator 把房间恢复为状态 1 |
| `abort` | 先在本地事务中退款并取消 active quest，提交后再 best-effort 通知 coordinator；房主放弃时解散房间，成员放弃时从权威当局参与者中移除并立即重判剩余成员是否全部 Finalize |
| `play_continue` | 同时核对内存与 SQLite active quest；SQLite 提交成功后才更新内存 continue count。当前多人续关不扣星导石 |

多人客户端会让每位真人分别请求 `start`，因此 active quest 是玩家级状态，不由房主记录替代成员记录。房主身份使用 Hub 内部的 `nodeSessionId + viewerId` 复合身份判断，不能由请求字段或节点本地 player ID 声明。成员 start 的入场成本固定为 0，但仍会保存自己的 `play_id`、房间号和关卡身份，以供 finish、abort、重连与多场景结束校验使用。

`finish` 请求不要求携带 `room_number`；服务端从 active quest 恢复房间身份。`statistics` 必须是非空对象，`elapsed_time_ms` 必须为正安全整数，`add_mana`、`score` 和 `continue_count` 不得为负。Boost 点在 finish 时确认扣除，余额不足时整个结算拒绝，不会写成负数。

### 4.4 兼容路由

| 路由 | 当前职责 |
|---|---|
| `verify_access_token` | 按房间级随机 token 查询本地房间；有效时返回客户端要求的房主、关卡和房间字段，无效时返回 `room_exists: false` |
| `micro_community` | CN 社区兼容空响应 |
| `publish_room` | 外部社区未实现，明确返回 `success: false` |

单端点字段和最终状态以 `src/multi/http/` 注册源码及测试为准，不在本文复制完整请求体。

## 5. RoomState 语义

`raising_state` 是国服客户端 HTTP 响应解析器要求的字段。下表中的 Ready、Waiting、Battle 等名称来自客户端各数值分支对应的输入类型；“当前语义”描述的是服务端在这些客户端分支约束下采用的状态机行为。

当前服务端只写入 1、2、4 三个房间状态；9 和 13 只用于 HTTP 返回。

| 值 | 当前语义 | 写入或返回时机 |
|---:|---|---|
| 1 | Ready | 房主进入 lobby；当局全部真人 Finalize 后由 coordinator 恢复为可重赛状态 |
| 2 | Waiting | 新建房间初态；房主尚未进入时客人继续轮询 |
| 4 | Battle | TCP lobby 收到房主 StartBattle 并固化当局成员后进入战斗 |
| 9 | Missing | `select_room`、`prepare` 或 `restore_room` 找不到房间时返回 |
| 13 | NotMate | `restore_room` 的 viewer 不是该房间已记录成员时返回 |

状态 9 不会存入房间。客户端收到它时应把目标房间视为不存在或已经过期。

当前服务端不写入历史值 `raising_state=3`。NPC 招募不会把房间改为 3，而是保持 1，直到开始战斗时直接进入 4。

## 6. TCP 握手与 lobby 流程

### 6.1 Room socket 握手

客户端使用 `socklet=cooperation_room` 连接 TCP，并提供 viewer、room number 和 connection ID。服务端执行：

1. 校验房间存在，状态为 Waiting/Ready，握手关卡与房间一致；
2. 新成员加入时按真人成员资格校验房间仍有空位；NPC 槽位可被真人替换，已记录成员也不受满员判断影响，可以断线重连；
3. 通过 viewer session 解析当前玩家和存档；
4. 从数据库构建真实玩家 party；
5. 按 `room.host_viewer_id` 写入本连接的 `isHost`，并以 `nodeSessionId + viewerId` 记录房间成员资格；TCP admission 虽按 `roomNumber + viewerId` 一次性定位，但消费后必须确认返回 participant 的 viewer 与握手 viewer 相同；
6. 注册 lobby client并返回 Accept 数组：

```text
[0, connectionId, roomNumber]
```

握手阶段只完成连接注册。Welcome 和 Mates 在客户端随后发送 Enter notify 后进入 lobby 流程。

首个 `socklet` 握手是每条 TCP 连接的顺序屏障。握手与 Enter、SceneReady 等后续帧即使出现在
同一个 TCP 数据块中，服务端也必须保留后续帧，等待连接注册和节点会话复核完成后再按原顺序处理；
握手失败、节点失效或连接关闭时不再处理排队帧。客户端和 Launcher 不需要为此人为增加发送延迟。

客户端协议中的 `MeetingNotifyMessage.Bye`（Notify index 1）是客户端定义的无参数枚举消息，不是 HTTP 字段，也不等同于“玩家主动退出房间”。客户端停止使用当前 `cooperation_room` 连接时会发送它，主动离开和进入战斗时的连接切换都可能走同一消息；因此服务端必须结合 `raising_state` 解释，不能仅凭名称判断为解散。

成员资格在房间内保存完整 `nodeSessionId + viewerId`，不从当前在线 socket 反推，因此远程成员临时离线后不会退化成 `embedded + viewerId`。结算事实的授权、Finalize 和移除也使用相同复合键；服务端不能在这些状态中只用 viewer 区分成员。成员资格与 socket 在线状态分开保存：战斗前普通网络断开只移除连接并启动 `MULTI_ROOM_RECONNECT_GRACE_MS` 宽限，宽限内保留 `restore_room` 资格；明确 `Bye` 仍立即释放 guest 或解散 host。进入 `raising_state=4` 后，切换 battle socket 产生的 `Bye` 只关闭 lobby 连接，必须保留房间、当局成员快照和 SceneReady 屏障，直到战斗结算或中止流程清理。

### 6.2 Battle socket 握手

客户端使用 `socklet=cooperation_battle` 和 connection ID 建立 battle socket。只有房主的 lobby StartBattle 可以固化当局真人成员的 connection ID/viewer ID/player ID 快照；服务端要求房间已进入战斗状态、请求身份属于该快照且尚未注册 battle socket。快照不依赖 lobby 或 battle socket 持续在线，合法成员断线后仍保留当局重连资格；每代 BattleStart 的送达记录也按 connection ID 保留，重连者只补收自己遗漏的代次。校验通过后继承快照中的 viewer/player 身份，登记到 battle client 集合并返回。战斗开始后临时建立但未进入当局成员快照的 lobby 连接会被拒绝：

```text
[0, roomNumber, ""]
```

SceneReady 只统计已登记的 battle client。

### 6.3 Lobby 关键消息

客户端顶层消息：

| Index | 名称 | 当前处理 |
|---:|---|---|
| 0 | Notify | 进入、关闭房间连接、换队、准备、心跳、开始和 NPC 招募 |
| 1 | Broadcast | 广播给同房 lobby client |
| 2 | Send | 按 viewer 定向发送 |

当前 Notify 重点分支：

| Index | 名称 | 当前行为 |
|---:|---|---|
| 0 | Enter | 更新本人 party，发送 Welcome，并同步 Mates |
| 1 | Bye | 客户端定义的通用 lobby 连接结束通知；服务端结合 `raising_state` 决定释放成员、解散房间或仅关闭连接 |
| 2 | ChangeParty | 更新当前 party 并广播 Mates |
| 3 | Ready | 更新准备状态并广播 StateChanged |
| 4 | Heartbeat | 回 AckHeartbeat |
| 6 | StartBattle | 设置预期 battle client 数量、`raising_state=4`，并广播 Start |
| 10 | EnterComs | 调用 NPC 招募流程 |

服务端关键消息：

| Index | 名称 | 当前用途 |
|---:|---|---|
| 0 | Welcome | 返回本人及握手初始成员 |
| 1 | Mates | 同步完整成员列表 |
| 2 | StateChanged | 同步指定成员准备状态 |
| 5 | Start | 下发进入战斗的成员数据 |
| 6 | Disbanded | 通知房间解散 |
| 7 | RemainingTime | 非战斗房间过期前的剩余时间 |
| 11 | AckHeartbeat | 回传当前 connection ID |

Welcome 的成员列表必须包含客户端本人。Mates 在成员加入、离开、换队或 NPC roster 变化时更新。

## 7. Option 包装与字段命名

Typepacker 中的可选值使用 Haxe `Option<T>`：

```text
[0, value]  Some(value)
[1]         None
```

session party 的角色、合击角色、装备和能力魂槽位都必须按 Option 包装。空槽不能直接写 `null`。

关键字段名按传输上下文区分：

| 上下文 | 字段 | 当前格式 |
|---|---|---|
| session party | 合击角色 | `unison_characters` |
| session party | 装备 | `equipmentId`、`enhancementLevel` |
| session party | 能力魂 | `abilitySoulIds` |
| session character | 插画设置 | `illustration_settings: [1]` |
| session character | EX Boost | `ex_boost` 使用 Option |
| HTTP `summon` 模板 | 装备 | `equipment_id`、`enhancement_level` |
| HTTP `summon` 模板 | 能力魂 | `ability_soul_ids` |

不要因为 HTTP mate 和 TCP session 都包含 party，就把 snake_case 与 camelCase 结构混用。

## 8. Party 与 `mana_node_ids`

真实玩家 party 由玩家快照从 SQLite 构建。角色和合击角色的 `mana_node_ids` 必须是 IntMap 形态，例如
`{ "1001": 0, "1002": 2 }`。

规则如下：

- key 是已学习 mana node ID 的字符串形式；
- value 是该节点持久化的 `awake_level`，未觉醒节点为 `0`；
- 真实玩家角色不得把 `mana_node_ids` 序列化为数组；
- 空的真实玩家 mana node 集合也应表达为空对象，而不是 `[]`；
- `illustration_settings` 必须随 session character 一起提供。
- NORMAL 与 EVENT 编队组各一次读取，再选择目标普通编队和最多两个 NPC 编队；角色、玛纳节点和装备按去重 ID 集合批量查询，能力魂沿用配队中的 `abilitySoulIds`。
- 检入的完整快照基线执行 7 次 `SELECT`；重复角色或装备引用不增加查询数。该数字是固定 fixture 的结构门禁，不是所有请求形态的全局常量。

`src/multi/npc/builder.ts` 的静态 HTTP NPC 模板是另一条数据路径，当前允许 `mana_node_ids: []`。它不构成真实玩家 session party 使用数组的依据。

因此当前边界是：

| 数据来源 | `mana_node_ids` |
|---|---|
| 真实玩家或从玩家存档构建的 session party | IntMap 对象 |
| 静态 HTTP NPC 模板 | 空数组 |

不得写入“所有联机角色必须使用空数组”之类的全局结论。

## 9. NPC 与真人成员边界

`IRoomMateProvider` 定义成员来源的最小接口，包括读取 mates、执行招募、判断房间是否已满和查询可用同伴。

当前只有 `NpcMateProvider` 实现该接口。它返回 NPC 招募身份；NPC party 由静态模板、房主的 NPC 命名编队或房主 party 回退组合而成。

真人成员当前不经过 `RealMateProvider`：

- lobby socket 由 `SessionManager` 管理；
- viewer 通过 session 映射到真实 player；
- party 由 `readMultiplayerSnapshot()` 批量读取，并由 `buildPlayerSnapshot()` 投影；
- 已连接真人与 NPC 一起组成最多三人的 Mates 列表。

服务端已实现 25 秒断线重连宽限、权威席位释放、重赛 NPC 幂等补位和已 Enter 客户端 roster 同步。仍未完成的是随机匹配、公开成员发现、完整客户端异常矩阵和真实双客户端验收，不能据此标记为真人联机已完成。

NPC 昵称与贡献规则见[NPC 昵称贡献](../systems/npc-contributor-names.md)。

## 10. 实际房间生命周期

```text
create_room
  -> raising_state=2 (Waiting)
  -> 房主 TCP handshake + Enter
  -> raising_state=1 (Ready)
  -> Ready / NPC 招募 / StartBattle
  -> raising_state=4 (Battle)
  -> 全部剩余真人 Finalize，coordinator release/reset
  -> raising_state=1 (保留现有房间，允许重赛)
```

### 10.1 Finish

每个玩家的 `finish` 完成以下操作：

- 在本地写事务前查询 Hub 保留的参与者、`battleSessionId` 和 Finalize 完成事实；
- 通过 coordinator 处理权威房间生命周期；全部真人已 Finalize 时释放当局 battle 状态并把房间恢复为 Ready；
- 在玩家自己的 SQLite 事务内重新比对并消费 active quest，同时结算奖励、关卡进度和任务 tracker；
- 本地事务失败时整体回滚，active quest 与 Hub 限时保留的完成事实可供重试。

实现分为三个明确边界：`prepareMultiplayerSettlement()` 在事务前完成 BattleFact/finalize 授权；`runMultiplayerSettlementOrchestration()` 在单个 SQLite 事务内重新读取权威玩家状态并执行奖励、任务与 active quest 清理；`projectMultiplayerFinishResponse()` 只构造现有客户端协议响应。

`finish` 不直接解散房间，也没有专用的 60 秒回房定时器。client 模式不读取或重置节点本地 room manager；embedded、host 和 client 都经同一 coordinator 契约处理房间。只要 lobby 连接仍在，完成后的房间可以继续用于重赛；否则由连接断开规则和通用非战斗空闲清理决定房间寿命。

### 10.2 Abort 与主动解散

- 房主 `abort` 先在自己的 SQLite 事务中退款并取消 active quest，提交后再通过 coordinator 解散房间；
- `disband_room` 对现存房间仅允许房主广播 Disbanded 并删除房间；客户端重复清理已经不存在的房间时返回成功，不触发 H403；
- 非房主 abort 同样先提交自己的退款和 active quest 删除，再通过 coordinator 移除自身 battle 连接、屏障资格和 retained fact 授权；移除后若剩余成员已经全部 Finalize，coordinator 立即 release 当局并保留已完成成员的 retained fact；
- 本地事务失败时不调用 Hub，原请求可以重试；本地提交后 Hub cleanup 失败时仍返回本地成功，不回滚退款。node session 使用五分钟滑动空闲 TTL，控制认证和 Host TCP 的每秒有效性检查会同时刷新 `lastSeen` 与 `expiresAt`，持续活动的房间不会在注册满五分钟时被强制断开；连接停止活动满 TTL 或 credential revoke 后，Hub 的失效回调按 active rooms 扫描并移除该 session 的 guest battle fact、参与者和连接，再次重判 release，因此遗漏的 Hub abort 仍会有界收敛；
- 重复 abort 因 active quest 已删除而失败，不会重复退款或再次调用 Hub。失效扫描只在 node invalidation 事件执行，不给请求热路径增加索引或扫描。

### 10.3 连接断开

- battle client 断开时从 battle 集合移除，并通知其他 battle client；
- battle client 断开本身不直接改变 `raising_state`；
- 最后一个非 battle lobby client 断开、房间没有 battle client 且状态不是 4 时，房间解散；
- 房间仍有 lobby client 时，离开成员从 Mates 中移除并广播更新。

### 10.4 空闲清理

cleaner 默认每 60 秒扫描一次非战斗房间：

| 条件 | 默认过期时间 |
|---|---:|
| `state=1/2` 且成员少于 3 | 15 分钟 |
| `state=1/2` 且成员达到 3 | 30 分钟 |
| `state=4` | cleaner 跳过 |

过期前 30 秒，服务端可以发送 RemainingTime。`state=4` 不存在通用“战斗 10 分钟自动清理”规则。

## 11. Battle relay 与场景屏障

Battle 顶层消息仍使用 Typepacker 数组：

| Index | 名称 | 当前行为 |
|---:|---|---|
| 0 | Notify | 处理 SceneReady 及部分控制帧 |
| 1 | Broadcast | 中继给同房其他 battle client |
| 2 | Send | 中继定向消息结构 |

普通 `Broadcast` 帧会被包装为带来源 connection ID 的服务端消息，并发送给同房其他 battle client。移动、技能、FEVER、协力球和自动战斗等普通帧可以沿这条路径中继。

SceneReady 当前可用：

1. lobby StartBattle 记录预期真人 battle client 数量；
2. 每个 battle client 发送 SceneReady；
3. 达到预期数量后，服务端向已连接 battle client 发送 BattleStart；
4. BothBoss 关卡的合法 LevelNext 会开启第二代屏障，并在第二次全员就绪后再次发送 BattleStart。

CN Notify 索引已经按 `SceneReady=0`、`LevelNext=1`、`Finalize=2`、`Measurement=3`、`LineSpeedWarning=4`、`Heartbeat=5` 分派。LevelNext 只允许主数据 `isBothBoss=true` 的 Boss Battle 入口；普通关卡和隐藏配置不能开启第二场景。第二代只接受已发送 LevelNext 的连接进入 SceneReady，重复消息保持幂等；BothBoss 提前 Finalize/HTTP finish 会被拒绝，等待期间 battle client 断线会缩减屏障人数。

当前仍不恢复进程重启后丢失的场景 generation 或 TCP socket；Measurement 和线路告警只实现协议所需的基础响应/广播，没有网络质量统计系统。

普通 Broadcast 可中继不等于协议覆盖全部战斗场景。超级猫头鹰边界见[多场景联机分析](./super-owl-multiscene.md)。

## 12. 当前验收口径

| 场景 | 当前结论 |
|---|---|
| NPC 房主建房、招募、准备、开始、结算 | 基础流程已有实际使用 |
| 土俑等特殊关卡的单人或 NPC 结算 | 以对应系统文档和测试矩阵为准 |
| NPC 重赛 | 服务端生命周期已覆盖，完整客户端回归待做 |
| NPC 贡献昵称显示 | 服务端数据已接入，客户端显示待验收 |
| TCP 中断与恢复 | 服务端有清理测试，客户端完整矩阵待验收 |
| 真人双客户端 | 服务端连接与广播基础存在，缺少完整验收条件 |
| 真人随机匹配 | 缺失 |
| 超级猫头鹰多场景 | 服务端状态机已实现，CN 客户端待验收 |

其中“真人双客户端”已有三个编译服务进程的自动集成覆盖，包括各自 SQLite、两至三人 TCP、Host-only 扣费和本地奖励；表中缺口专指 CN 客户端真机交互、显示与异常体验验收。

全项目人工状态以[测试进度](../status/test-progress.md)和[支持矩阵](../status/support-matrix.md)为准。自动测试通过不得写成客户端已经通过。

## 13. 源码与测试入口

主要源码入口为 `src/multi/http/register.ts`、`src/multi/http/`、`src/multi/tcp/`、`src/multi/room/`、`src/multi/state/`、`src/multi/npc/`、`src/multi/snapshot/` 和 `src/multi/settlement/`。握手负责调用快照提供方；真实 party 的读取与投影核心位于 `src/multi/snapshot/player-snapshot-reader.ts` 和 `src/multi/snapshot/player-snapshot.ts`，viewer 到存档的解析位于 `src/multi/player-context.ts`。

主要自动测试：

| 测试 | 关注点 |
|---|---|
| `tools/handshake_lifecycle.test.cjs` | 握手生命周期与停止竞态 |
| `tools/multi_room_handshake_identity.test.cjs` | room socket 的存在性、状态、满员、关卡和房主身份边界 |
| `tools/multi_room_identity.test.cjs` | 随机 token、HTTP 权限、成员恢复和外部社区关闭响应 |
| `tools/lobby_lifecycle.test.cjs` | NPC 招募、成员、准备和重赛状态 |
| `tools/multi_lifecycle_faults.test.cjs` | fallback 重试、来源缓存代次与重赛故障注入 |
| `tools/perf/multi_snapshot_baseline.test.cjs` | 快照行为签名、依赖调用与 SQLite SELECT 上界 |
| `tools/perf/multi_settlement_baseline.test.cjs` | 完整 finish 响应签名、授权顺序、事务与 SQL 上界 |
| `tools/perf/hub_baseline.test.cjs` | 动态端口双服房间、心跳、故障注入与资源归零 |
| `tools/room_cleanup_lifecycle.test.cjs` | 15/30 分钟清理与 `raising_state=4` 跳过 |
| `tools/session_frame_order.test.cjs` | Room/Battle 握手后同包首帧顺序与拒绝清理 |
| `tools/session_server_lifecycle.test.cjs` | TCP 启停和会话生命周期 |
| `tests/multi-hub-process.test.js` | 三编译进程、独立 SQLite、兼容/时间/身份准入、BothBoss、会话轮换与 Hub degraded |
| `tools/multi_player_context.test.cjs` | viewer、账号与存档映射 |
| `tools/npc_contributor_names.test.cjs` | NPC 昵称数据契约 |
| `tools/npc_nickname_pool.test.cjs` | 昵称抽样和房间稳定性 |

CDN 版本、下载和内容同步不属于多人协议本文职责，统一见[CDN 与内容文档](../cdn/README.md)。
