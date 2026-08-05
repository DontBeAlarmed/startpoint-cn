# 可信局域网多人 Hub 架构设计

状态：已确认设计

日期：2026-08-05

## 1. 目标

本设计把当前进程内多人联机能力抽象为可选的联机 Hub，使多个各自持有独立存档的服务端可以在受信任局域网或 VPN 内共同联机。

首期必须满足：

- 手机壳中的游戏客户端继续把主 HTTP API 指向本机 `127.0.0.1`；
- 两台设备分别运行自己的服务端和存档，无需导入、导出或合并存档；
- 游戏客户端从房间响应取得 Hub 的 TCP 地址并直接连接；
- 体力、门票、奖励、任务和进度始终由玩家自己的本地服务端处理；
- 未配置 Hub 时保持现有单服务端行为；
- Hub 故障只关闭多人能力，不影响单人游戏、存档和管理后台；
- 不同客户端、CDN、业务表或 Mod 只进行兼容性比较，不自动更新或转换。

## 2. 首期不实现

首期明确不实现：

- 公网开放联邦、开放节点注册或互不信任节点隔离；
- TLS、证书签发、VPN、路由器、防火墙和 NAT 穿透；
- 随机匹配、公开房间大厅和跨 Hub 房间发现；
- Hub、房间和 TCP 会话的跨重启恢复；
- 在节点间复制完整存档、数据库、库存或账号凭据；
- 因联机版本差异触发 CDN 下载、`asset_update`、Content Release 切换或客户端更新；
- 自动判断不同版本客户端、CDN 或 Mod 是否“实际上兼容”；
- 修改客户端来扩展身份协议；
- 服务器名称、持久化服务器注册表或服主协商的 ID 段。
- 联机时自动修改参与节点的服务器时间，或把时间对齐作为房间准入条件。

## 3. 当前耦合事实

当前 `src/multi/` 已按 HTTP、TCP、房间、状态机和 NPC 分目录，但仍是单进程实现：

- `room/manager.ts` 的房间保存在模块级 `Map`；
- `SessionManager` 保存 lobby、battle socket、准备状态和多场景屏障；
- 多人 HTTP 路由直接访问房间与 `SessionManager`；
- TCP room 握手直接读取本地 session、玩家、配队、角色和装备；
- TCP lobby 配队切换会直接写本地 `partySlot`；
- `/start` 和 `/finish` 依赖进程内房间与最终场景状态完成本地结算；
- 生命周期把本地 TCP 视为主服务 ready 的必需条件。

因此，只把 `SESSION_PUBLIC_HOST` 指向另一台服务端无法运行。远端 TCP 没有创建房间的内存状态，也无法读取玩家所属服务端的 SQLite。

客户端协议允许主 HTTP 和 TCP 位于不同地址：多人 HTTP 始终使用游戏主 API，`select_room` 或 `prepare` 响应中的 `ip_address`、`port` 决定 TCP 连接地址。这是本设计无需修改客户端的基础。

## 4. 运行模式

新增一个配置项：

```text
MULTI_MODE=embedded | host | client
```

### 4.1 embedded

默认模式。主服务使用进程内 Coordinator 和本地 TCP，保持现有部署与客户端体验。

```text
主服务 -> 进程内 Coordinator -> 本地 TCP
```

### 4.2 host

主服务同时运行进程内 Coordinator、最小 Hub 控制接口和对外 TCP。该节点自己的玩家直接调用进程内 Coordinator，不通过回环 HTTP 调用 Hub。

```text
主服务 -> 进程内 Coordinator -> 对外 TCP
                         `----> Hub 控制接口
```

### 4.3 client

主服务不监听本地多人 TCP。多人 HTTP 仍由本地服务接收，但房间控制操作通过远端适配器调用 Hub。游戏客户端最终直接连接 Hub TCP。

```text
游戏 HTTP -> 本机服务 -> Remote Coordinator Adapter -> Hub 控制接口
游戏 TCP  --------------------------------------------> Hub TCP
```

`client` 节点也可以在同一 Hub 创建自己的房间；`host` 只表示基础设施角色，不等于游戏房间房主。

## 5. 组件边界

### 5.1 MultiCoordinator

`MultiCoordinator` 是房间控制面的稳定接口，负责：

- 创建、查询、准备、解散和恢复房间状态；
- 房间成员资格和游戏房主身份；
- lobby 成员、准备状态、NPC 和配队广播；
- battle 参与者、帧中继、场景屏障和最终完成状态；
- `battleSessionId` 与短期结算记录；
- 房间与临时记录的过期清理。

多人 HTTP 路由不再直接访问全局 `rooms` 或 `SessionManager`。

### 5.2 LocalPlayerSnapshotProvider

该组件只在玩家所属服务端读取 SQLite，生成 Hub 所需的最小临时资料：

- `viewerId`、昵称、等级、称号和主角色；
- 当前配队的角色、合击角色、装备、能力魂和养成数据；
- 房主招募 NPC 时最多需要的 NPC 配队快照；
- 当前关卡、房间和兼容性资料。

它不得发送登录 token、设备 ID、完整角色或装备仓库、货币、库存、邮件、任务、进度或数据库文件。

### 5.3 RemoteCoordinatorAdapter

该组件在 `client` 模式下把本地多人 HTTP 操作转换为 Hub 控制调用，并把 Hub 内部结果映射回现有国服客户端协议。它不得代理主游戏 API、管理后台或 CDN。

### 5.4 MultiSettlementVerifier

本地 `/start`、`/finish`、`abort` 和恢复流程通过该组件查询 Hub 的成员、房主、关卡、战斗和最终场景事实。所有玩家数据写入仍在本地数据库事务中完成。

## 6. 节点与玩家身份

节点使用服主为其分发的独立随机令牌接入 Hub。令牌只接受 32 至 128 位 URL 安全字符，格式为 `[A-Za-z0-9_-]`；推荐生成 32 字节随机数并编码为 64 位十六进制或 43 位 base64url。服务端只能校验格式和长度，随机性与可信分发由服主负责。`123`、空值、空白字符和超长令牌必须在节点注册前拒绝。

Host 在运行数据目录维护私有密钥表。每项只保存随机 `credentialId`、服主填写的备注、令牌 SHA-256 摘要、创建时间和撤销时间，不保存可再次导出的明文令牌。密钥数量不设业务上限；同一密钥被分发给多个节点时，这些节点只能作为一个撤销单元处理。密钥可以撤销但不恢复，误撤销时生成新密钥。

Hub 在内存中为每次节点注册生成随机 `nodeSessionId`，并关联认证所用的 `credentialId`。后续控制调用使用节点会话凭据，Hub 重启后全部失效。普通日志可以显示密钥备注和缩短后的 `credentialId`，不得显示明文令牌或完整摘要。

密钥表由管理命令原子更新，Hub 以短周期检查文件身份与修改时间；文件没有变化时不得重新读取。有效更新整体替换内存快照，非法文件保留上一份有效快照并产生明确告警。撤销不建立主动推送式 Socket 索引；每次 Hub 控制调用和 TCP 入站消息只以 `credentialId` 对内存快照执行 O(1) 状态查询。发现撤销后立即使节点会话失效、关闭对应连接，并复用现有断线流程清理 admission、成员和房间。空闲连接最迟在下一次心跳或会话过期时清理，因此该语义是近实时撤销，不承诺操作命令返回时所有连接已经同步关闭。

Hub 内部玩家身份为：

```text
nodeSessionId + viewerId
```

该组合只用于 Hub 内部索引和把查询结果路由回正确节点，不进入客户端协议、玩家存档或服务器注册表。

不同服务端的本地数据库 `playerId` 很容易重复，Hub 不以它作为跨节点身份，也不把它用于房主或结算判断。本地结算始终使用所属服务端的真实数据库 `playerId`。客户端请求中的 `mate_player_ids` 实际来自 mate 的 `viewerId` 列表，因此继续使用已经过同房唯一性检查的裸 `viewerId`。

国服客户端会用裸 `viewerId` 在 mate 列表中查找自己，因此同一房间出现相同裸 `viewerId` 时无法仅靠服务端内部命名空间解决。Hub 必须在查房或准备阶段拒绝后加入者。不同房间可以存在相同 `viewerId`。

冲突判断必须区分来源：同一 `nodeSessionId + viewerId` 的重复控制请求按幂等请求或同节点重连处理；不同 `nodeSessionId` 携带相同裸 `viewerId` 加入同一房间时返回内部 `VIEWER_ID_CONFLICT`。后加入者不会写入成员列表、不会取得 TCP admission、不会连接 TCP，也不会触发 active quest、扣费或存档写入。原房间和先加入者不受影响。

## 7. 兼容性身份

兼容性比较按参与玩家进行，而不是在节点注册时把整个节点拒绝。一个 Hub 可以同时维护多个互不兼容的房间。

房间兼容信息包含：

```text
multiProtocolVersion
APP_VER
RES_VER
cdnTargetVersion
contentDigest
modeDigest
```

- `multiProtocolVersion` 是 Hub 内部接口和多人状态契约版本；破坏兼容时递增。
- `APP_VER`、`RES_VER` 来自该玩家当前多人 HTTP 请求的客户端头。
- `cdnTargetVersion` 来自本地固定 `ContentSnapshot.cdn.targetVersion`。
- `contentDigest` 表示服务端实际加载的业务表快照。当前激活的 Content Release 令
  `ContentRepository.info().contentDigest` 等于 `releaseDigest`；bundled fallback 在
  `ContentRepository` 完成全部注册表加载时，对实际 entries 分别生成 canonical SHA-256，再按表名的
  code-point 顺序组合并一次性保存到 `info()`。兼容资料只读取 `info()`，不再次访问任一 `table()`。
  两条路径都不读取候选或失败 Release，不扫描 CDN 大文件，也不触发 `content:sync`。
- `modeDigest` 只包含依次通过 allowlist SHA、静态 manifest、`register()` 和 Registry 注册的 Mod 身份，
  以文件名、manifest 名称与 capability、已验证文件 SHA 按稳定顺序组合。禁用、摘要不符、manifest
  不兼容、加载失败或注册失败的模块不计入。

服务端版本和 Bundle ID 只用于后台与日志诊断，不作为唯一兼容条件。两个节点只有上述字段完全一致时才允许同房。

兼容校验严格只读：

- 不调用 CDN 下载接口；
- 不设置或修改 `asset_update`；
- 不切换 Content Release；
- 不要求另一名玩家安装房主的资源；
- 不推测不同版本是否可以正常战斗。

服务器当前时间不属于兼容性身份，也不要求各节点时钟、全局 `timeOffset` 或所处日期一致。时间只用于每名玩家所属服务端判断当前关卡是否可参与：双方不必处于活动的同一天，只要同一关卡在各自服务器时间下都处于可挑战区间即可。

关卡资格的权威周期来自 20 张已注册 CN Quest OrderedMap 行内的 `TimeRange`。Content Sync 按国服
`AppTimeConfig` 的 UTC+8 日历语义把 `start_time`、`end_time` 转为 `availableFromMs`、
`availableUntilMs`；年份只接受 `1970..2200`（含边界），无界端保持 `null`，越界年份、非空非法日期或
倒置周期拒绝生成 Release。Quest converter v4 会使 normal sync 在同 CDN 版本下自动重建旧 v3 Release，
无需 `--force`。旧 bundled 关卡 JSON
尚无这两个字段时，普通与练习关卡保持原有可用行为；只有明确活动关卡分类因缺少权威周期而 fail closed。
一旦任一周期字段出现，缺少另一字段或值非法同样 fail closed，不推测永久开放。

角色、装备、能力魂、Mana Node、觉醒能力和 EX Boost 不按发布时间再次校验。玩家所属服务端负责确认配队来自其真实存档，并生成只读玩家快照；双方内容定义是否存在则由 `contentDigest` 和 `modeDigest` 保证。已经获得的活动或后期内容不会因为另一节点时间较早而失效。

## 8. 房间与战斗流程

### 8.1 创建房间

1. 房主客户端向自己的本地服务调用 `create_room`。
2. 本地服务校验 session、玩家、配队，并按自己的服务器时间确认关卡当前可挑战。
3. 本地服务生成玩家快照与兼容信息。
4. Coordinator 创建房间并固定该房间的兼容信息。
5. 客户端得到现有格式的房间号和 access token。

### 8.2 搜索房间

1. 客机客户端向自己的本地服务调用 `search_room`。
2. 本地服务从请求头取得该客户端的 `APP_VER`、`RES_VER`，并加入本地内容与 Mod 摘要。
3. Hub 比较客机资料与房间资料。
4. 本地服务取得房间关卡后，按自己的服务器时间确认该关卡当前可挑战；不满足时生成内部 `QUEST_NOT_AVAILABLE`。
5. 兼容信息一致且关卡可挑战时返回现有查房成功结果。
6. 兼容信息不一致或字段缺失时，Hub 向本地服务返回结构化 `INCOMPATIBLE_ROOM` 与字段差异。
7. 同房裸 `viewerId` 冲突时返回结构化 `VIEWER_ID_CONFLICT`。
8. 本地服务把内部原因映射到对应端点已有的“无法加入”分支。

差异只写入 Hub 与客机服务端日志，并在后台显示；房间本身不删除，其他兼容玩家仍可加入。

客户端失败映射遵循现有端点能力：

- `search_room` 与 `verify_access_token` 遇到兼容性、身份或关卡资格失败时返回现有错误码 `4020`，进入客户端 `NotPlayable` 分支；
- 直接 `select_room` 遇到上述失败时返回 `raising_state=7`，进入客户端 `NotPlayable` 分支；
- `prepare` 复核时才发现兼容性、身份或关卡资格失败则返回现有错误码 `4507`，进入客户端通用 Failure 分支；
- 只有房间实际不存在时才返回 `room_exists: false`、`raising_state=9` 或对应的 RoomDataNotFound。

不得向 `prepare` 返回 `raising_state=7`，因为国服客户端的 Prepare 解析器不接受该状态并会抛出客户端错误。

### 8.3 准备与 TCP admission

`prepare` 必须再次执行兼容性、裸 `viewerId` 与本地关卡资格校验，防止查房后内容、身份或活动开放状态变化。成功后 Hub 创建短期、单房间的 TCP admission。由于官方 TCP 握手不携带额外认证 token，Hub 只接受已经由受信节点注册、且与 `roomNumber + viewerId` 匹配的下一次握手。

首期信任受信局域网或 VPN，不承诺抵抗同一网络中的恶意客户端冒充。

### 8.4 Lobby 与开战

客户端直接连接 Hub TCP。Hub 负责 Welcome、Mates、Ready、配队广播、NPC、StartBattle 和心跳。

客户端切换配队时会通过 TCP 发送新的完整配队。Hub 只在房间生命周期内保存和广播，不再直接写玩家所属数据库。最终 `party_id` 由该玩家稍后的本地 `/start` 请求写入。

开战时 Hub 生成唯一 `battleSessionId`，冻结：

- 房间、关卡和兼容信息；
- 游戏房主参与者；
- 所有真人与 NPC；
- 每人的 `nodeSessionId + viewerId`；
- 最终配队；
- 战斗与多场景完成状态。

### 8.5 本地 start

每名真人仍分别向自己的本地服务调用 `/multi_battle_quest/start`。本地服务通过 Coordinator 查询当前 `battleSessionId` 并确认：

- 请求玩家属于该战斗；
- 房间、关卡和 `play_id` 一致；
- 该玩家是否为游戏房主；
- 兼容性资料没有变化。
- 该关卡在玩家所属服务端当前时间下仍可挑战。

只有游戏房主所属服务扣除体力和门票。每名玩家分别在自己的 SQLite 中写 active quest，额外保存 `battleSessionId`。

### 8.6 本地 finish

每名真人仍分别向自己的本地服务调用 `/multi_battle_quest/finish`。本地服务从 active quest 取得房间与 `battleSessionId`，再向 Coordinator 查询：

- 该玩家是否属于战斗；
- 关卡与房主身份；
- 普通战斗或最终多场景是否完成。

确认后只结算本地玩家的奖励、任务与进度。Hub 不发奖、不修改存档。活动倍率、任务和奖励按各玩家所属服务端的时间独立结算，允许结果不同。重复请求继续由本地 active quest 和事务边界拒绝。

Hub 可以在战斗结束后把房间恢复为可重赛状态，但旧 `battleSessionId` 的完成记录默认最多保留 30 分钟，使较晚提交 finish 的成员仍可验证。记录只在内存中保存。

## 9. 失败与恢复语义

- Hub 不可用时，主服务仍进入可用状态；单人接口、存档和后台正常。
- 建房、查房或准备失败时，不写 active quest、不扣体力和门票。
- 本地关卡资格失败使用内部 `QUEST_NOT_AVAILABLE`；只拒绝当前玩家的创建或加入，不删除其他节点已经创建的房间。
- `search_room` 和直接 `select_room` 的兼容性失败映射为现有 NotPlayable 分支。
- `prepare` 复核失败映射为现有通用 Failure 分支。
- 只有房间实际不存在时才使用房间不存在响应。
- TCP 直连但没有有效 admission 时拒绝握手。
- `/start` 成功后断线保留本地 active quest，沿用现有中断语义，不自动退款。
- `/finish` 时 Hub 暂时不可达，不发奖、不删除 active quest，允许在完成记录 TTL 内重试。
- Hub 已重启或明确报告房间、战斗记录不存在时，按联机中断处理，不推测战斗成功。
- Host 的 Hub 控制端口或 TCP 故障只把多人状态标记为不可用，不关闭主 HTTP 或数据库。
- Hub 不在瞬时失败后自动创建 embedded 替代房间，也不自动切换 `MULTI_MODE`。

Hub 或主机服务重启后所有房间、节点会话、admission、socket 和战斗记录失效。首期不恢复原房间。

## 10. 配置契约

基础配置：

```text
MULTI_MODE=embedded | host | client
```

Host：

```text
MULTI_HUB_HOST=0.0.0.0
MULTI_HUB_PORT=8004
# 可选；默认位于运行数据目录
MULTI_HUB_CREDENTIALS_FILE=<private-credential-table-path>
SESSION_HOST=0.0.0.0
SESSION_PUBLIC_HOST=<reachable-lan-or-vpn-address>
SESSION_PORT=8003
```

Client：

```text
MULTI_HUB_URL=http://<host-address>:8004
MULTI_HUB_TOKEN=<token-issued-for-this-node>
```

`8004` 只注册最小 Hub 控制接口，不暴露主游戏 API、CDN、存档或管理后台。服务端提供显式的密钥管理命令：

```text
npm run multi:token -- create <label>
npm run multi:token -- list
npm run multi:token -- revoke <credentialId>
```

`create` 使用系统安全随机源生成 32 字节随机数，原子写入私有密钥表，并且只在本次命令输出一次 64 位十六进制明文令牌。`list` 显示备注、完整 `credentialId`、创建时间和撤销状态，以便将完整 ID 交给 `revoke` 精确匹配；普通服务日志仍只显示缩短后的 `credentialId`。`revoke` 只接受无歧义的完整 `credentialId`，重复撤销保持幂等。新建密钥表使用 `0600` 权限；已有文件保留原权限，不得放宽。写入采用短生命周期进程间锁、同目录临时文件和原子替换，防止并发管理命令丢失更新；任何失败都必须保留原文件。

令牌、密钥表和 Hub 地址不得提交仓库。首期仍只支持受信局域网或 VPN，不在服务端内实现 TLS。`8004` 不得直接暴露到公网；跨不可信网络时由部署者使用可信 VPN。

密钥表属于 Host 运行配置，不属于玩家存档。服务端不建立账号系统、设备身份、密钥导入导出或分发协议，也不能阻止被撤销节点改用另一条有效密钥。壳或经过认证的管理工具以后可以复用同一生成与密钥表函数，提供遮挡显示、复制和扫码导入，但不得改变服务端契约。Client 只在自己的 `.env` 或壳运行配置中保存服主分发的一条 `MULTI_HUB_TOKEN`；服务端命令不替 Client 猜测、生成或自动写入另一条令牌。

### 10.1 Hub 控制接口

Host 在 `MULTI_HUB_HOST:MULTI_HUB_PORT` 启动独立 Fastify 实例，JSON 请求体上限为 256 KiB。该实例只注册下列端点：

| 方法 | 路径 | 行为 | 写幂等键 |
|------|------|------|----------|
| `POST` | `/v1/multi/nodes/register` | 以集群令牌注册节点会话 | 否 |
| `POST` | `/v1/multi/rooms/create` | `MultiCoordinator.createRoom` | 是 |
| `POST` | `/v1/multi/rooms/search` | `MultiCoordinator.searchRoom` | 否 |
| `POST` | `/v1/multi/rooms/prepare` | `MultiCoordinator.prepareRoom` | 是 |
| `POST` | `/v1/multi/rooms/select` | `MultiCoordinator.selectRoom` | 否 |
| `POST` | `/v1/multi/rooms/disband` | `MultiCoordinator.disbandRoom` | 是 |
| `POST` | `/v1/multi/rooms/status` | `MultiCoordinator.getRoomStatus` | 否 |
| `POST` | `/v1/multi/admissions/issue` | 建立一次性 TCP admission | 是 |
| `POST` | `/v1/multi/battles/start` | `MultiCoordinator.startBattle` | 是 |
| `POST` | `/v1/multi/battles/finalize` | `MultiCoordinator.finalizeBattle` | 是 |
| `POST` | `/v1/multi/battles/status` | `MultiCoordinator.getBattleStatus` | 否 |
| `GET` | `/v1/multi/status` | 只返回有效密钥与活动节点会话计数 | 否 |

注册请求使用 `Authorization: Bearer <集群明文令牌>`，正文只包含 `protocolVersion`。成功响应包含随机 `nodeSessionId`、43 位 base64url `sessionCredential`、`expiresAt` 和 Hub TCP 的 `host/port`；不返回 `credentialId`、备注、令牌摘要或密钥表路径。后续调用不再发送集群明文令牌，而是同时发送：

```text
Authorization: Bearer <sessionCredential>
x-node-session-id: <nodeSessionId>
```

Hub 以固定长度和 timing-safe 比较校验会话凭据，并把请求中的 `participant.nodeSessionId` 强制绑定为已认证会话，节点不能代替另一节点发起操作。写端点还必须携带 1 至 128 位可见 ASCII `x-idempotency-key`；缓存按 `nodeSessionId + operation + key` 隔离，在房间变更 TTL 内返回相同 HTTP 状态和 JSON 结果，不重复调用 Coordinator。执行中的 pending 记录不参与 TTL 或容量淘汰；容量已全部被 pending 占用时，新 key 不执行操作并只返回 `503 HUB_UNAVAILABLE`。成功、有限业务失败和内部失败结果都在完成后进入相同 TTL 与最旧记录回收流程。业务失败使用 `{ ok: false, code }` 的有限错误集合；内部异常只返回 `HUB_UNAVAILABLE`，404 不回显请求路径，任何响应都不包含 stack、绝对路径或凭据。

凭据热加载器默认每秒只检查文件身份、大小和修改时间。元数据未变化时不读取文件；合法变化整体替换不可变内存快照，非法变化只记录无路径、无令牌、无摘要的告警并保留上一份有效快照。文件首次不存在按空快照启动，运行中合法创建后可直接注册。每次控制调用和 TCP 入站帧只通过节点会话关联的 `credentialId` 对快照做 O(1) 启用状态查询，不读文件也不重新计算集群令牌摘要。

密钥撤销或会话到期后，该节点会话会由下一次显式检查或后台 sweep 统一失效：先清除 admission，再通过 Embedded 的 Hub 内部清理 capability 解散该节点作为房主创建的未连接房间；其他节点房间不受影响。已经连接的 TCP 仍由中央 checker 在握手、下一帧或最多一次节点会话检查周期内关闭，并复用 lobby 断线流程移除成员和解散房主房间，不按凭据主动遍历 Socket。失效回调幂等，同一会话不会重复清理。另一条仍有效的密钥不受影响，可以继续注册新节点会话。Hub 控制面不读取服务器时间，`QUEST_NOT_AVAILABLE` 仍只由玩家所属服务端按自己的全局服务器时间生成。

## 11. 健康与诊断

运行健康状态区分：

- 主 HTTP 与数据库；
- 本地或远端多人 Coordinator；
- Hub 控制接口；
- Hub TCP。

多人不可用只产生 degraded 状态。后台显示模式、Hub 可达性、TCP 状态、活动房间数和最近的兼容性拒绝原因。

兼容性日志至少包含房间号、差异字段和双方值。摘要可以完整显示，但不得记录 Hub 明文令牌、令牌摘要、节点会话凭据、设备 ID 或登录 token。密钥撤销日志只记录备注和缩短后的 `credentialId`。游戏客户端只接收对应端点现有的 NotPlayable 或通用失败结果；只有房间实际缺失时才显示房间不存在。

## 12. 测试与验收

### 12.1 自动测试

必须覆盖：

- `embedded` 模式现有 NPC、真人和超级猫头鹰流程不回归；
- 两个独立临时数据库通过不同节点会话加入同一房间；
- 两条独立密钥可以同时注册，撤销其中一条只影响其关联节点；
- 密钥表未变化时心跳路径不读取文件，变化后热加载且每条消息只查询内存状态；
- 已撤销节点在下一次控制调用或 TCP 入站消息时断开，并执行 admission、成员和房间清理；
- 非法密钥表不会替换上一份有效内存快照；
- 两个节点本地 `playerId` 相同时仍分别结算；
- 不同节点的相同裸 `viewerId` 在搜索或准备阶段被拒绝，同节点重复请求保持幂等；
- 房主服务独自扣体力和门票；
- 每名玩家的奖励、任务与进度只写入自己的数据库；
- Hub 不可用时单人接口正常；
- Hub 重启后旧房间明确失效；
- 客户端、CDN、内容或 Mod 任一兼容字段不同都映射到端点已有的 NotPlayable 或 Failure 分支；
- 真正缺失的房间仍使用 RoomNotFound，兼容性失败不得伪装成房间缺失；
- 兼容性失败不会调用或修改 CDN 更新状态；
- 两个节点时间不同但都处于同一关卡开放期时可以加入；任一节点处于开放期外时只拒绝该节点，不删除房间；
- 后期角色、装备、Mana Node、觉醒能力和 EX Boost 不参与时间资格判断；
- finish 暂时无法查询 Hub 时不发奖、不删除 active quest；
- 普通战斗和超级猫头鹰最终多场景状态都能被各本地服务验证；
- 写控制调用的幂等请求 ID 不会重复创建房间或参战记录。

### 12.2 本机集成测试

一台开发机启动三个隔离进程：

```text
Hub/主机服务 + 客机服务 A + 客机服务 B
```

每个服务使用独立端口和临时数据库，验证房间、TCP、扣费、结算和故障隔离，不依赖多台手机。

### 12.3 壳与真机验收

自动测试通过后再由壳完成：

- 主机模式生成 Hub 地址与令牌；
- 客机模式配置同一 Hub；
- 两个客户端继续连接各自本机主 HTTP；
- 客机按房间号加入并直连主机 TCP；
- 两边结算后各自存档独立更新；
- 不兼容资源组合使用客户端已有的“无法加入”或通用失败提示，后台可见差异；
- Hub 停止后两边单人流程仍可使用。

## 13. 实施规模与顺序

预计生产代码约 2500 至 4500 行，测试代码规模与生产代码接近，整体约 2 至 4 周。实施顺序为：

1. 抽出 Coordinator、玩家快照和结算验证接口，`embedded` 行为保持不变；
2. 增加 Hub 控制接口、节点会话和 host 模式；
3. 增加远端适配器、client 模式和直接 TCP admission；
4. 接入 start、finish、abort、load 与多场景事实；
5. 增加兼容性摘要、只读查房校验、后台诊断和完整测试。

每阶段独立验证和提交，不在首期引入公网联邦、持久房间或自动资源对齐。

## 14. 后续可选的时间对齐与恢复

时间对齐是独立的服务端管理功能，不属于 Hub 控制面。Hub 后台以后可以只读显示节点时间差，但创建、搜索、准备和开战不得自动修改任何节点时间，也不得要求时间完全一致。

可选功能按以下边界设计：

1. A 节点导出带生成时刻的服务器时间配置；B 节点由管理者显式确认导入，使 B 的全局服务器时间从导入时刻起继续流动。
2. 导入前必须建立 B 的完整存档检查点。第一阶段只提供“保留现有领取状态”和“恢复到导入前检查点”，默认保留。
3. “重置周期领取状态”作为后续白名单功能，不做泛化数据库清理。候选范围包括每日/每周任务周期、每日/月度商店购买周期、登录奖励周期，以及有明确独立领取记录的活动或 Pass 周期。
4. 永久成就、角色养成、库存、邮件、抽卡历史和没有独立周期键的状态不得随时间导入自动清除。
5. 重置领取标记但不回收已到账奖励会允许再次领取；若以后需要无重复的严格恢复，必须依赖可逆奖励流水或恢复完整检查点。在奖励流水覆盖前，界面必须预览受影响领域并明确该风险。

时间对齐不能解决 CDN、业务表或 Mod 差异。无论是否使用该功能，多人房间仍执行相同的内容身份比较和本地关卡资格检查。
