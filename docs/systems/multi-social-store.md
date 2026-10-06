# 多人社交共享存储（铃铛招募 + presence）

## 定位

多节点/多进程部署时社交状态的平等读写落点：设置 env `MULTI_SOCIAL_DB_PATH` 指向共享
SQLite 文件后，铃铛招募（`attention_recruitments`/`attention_deliveries`）与 presence
（`social_presence` 表 TTL）全部经由该共享库，各进程独立打开连接（WAL +
`busy_timeout=5000`），无主客机身份。单机单进程不设置该 env：attention 走主库、
presence 走节点内内存 Map（与 A1 行为一致）。

## 部署硬前提

- **共享文件必须位于本地文件系统**（所有进程同一主机）。SQLite WAL 明确不支持
  NFS/SMB 等网络文件系统——跨机共享一个网络盘上的文件会损坏数据。多机部署需要
  PG 后端（接口已备，驱动/拓扑待定）。
- **全部节点必须以相同的 `timeOffset` 启动**：attention 时间戳为虚拟钟
  （`getServerTime()*1000`），两节点偏移不一致时铃铛会瞬间过期或永不过期
  （presence 用真实时钟，不受影响）。
- 写竞争纪律：`BEGIN IMMEDIATE`（`immediate()` 事务变体，杜绝 deferred 事务的
  BUSY_SNAPSHOT）+ `busy_timeout=5000`；`/attention/check` 热路径对 touch/deliver
  降级容错（presence 丢失无害、`multi: []` 客户端合法）。

## 组成

| 模块 | 职责 |
|---|---|
| `src/data/social/attention-schema.ts` | 社交域 DDL 单一来源（主库初始化器与共享库共用，幂等） |
| `src/data/social/shared-db.ts` | `MULTI_SOCIAL_DB_PATH` 单例连接（WAL + busy_timeout + 幂等 DDL；随 `closeDatabase` 一并优雅关闭） |
| `src/data/domains/attention.ts` | `AttentionStore` 接口 + SQLite 实现 + 兼容函数委托（env-aware 单例） |
| `src/multi/presence.ts` | `PresenceStore` 接口 + 内存/SQLite 双实现 + 兼容函数委托 |

## 语义（与单进程一致）

- 读时惰性投递：任何进程的 guest 轮询 `/attention/check` 都从同一共享存储收敛投递行；
  房主在进程 A 开的招募，进程 B 的 guest 下次轮询即收到。
- `recordResponse` 仅 delivered → accepted/declined 单向；跨连接立即可见。
- presence：touch 30s 节流 + 5min 在线窗口（双常量，真实时钟域 `getRealNowMs()`），
  touch 时惰性清扫过期行。
- 过期清理 `pruneExpiredRecruitments`：标记 expired + 超 24h 连投递历史删除。

## 边界（明确不在本层）

- 战斗房间状态（相位机/每房间串行队列/TCP 会话）仍是 coordinator/hub 域的进程耦合
  实时态；跨节点进房走既有 hub 路径。参考服路线图把该迁移列为独立专项。
- PG 后端：`AttentionStore`/`PresenceStore` 接口即接入形态，驱动与部署拓扑待定，
  本仓不引入第三方依赖。
- 双实例真实进程集成（两个服务进程同时起）在 `tools/social_store_shared.test.cjs`
  以同文件双连接模拟；真实多进程部署验证待用户侧拓扑决策。

## 与参考服的关系（借鉴与差异）

参考服 = `Ku1o/startpoint-cn-private`（私库，仅本地）。三个借鉴点如实留痕：

- **presence 双常量**（30s 节流 / 5min 在线窗口）来自其 `src/lib/online-presence.ts`；
  差异：参考服把 30s 节流挂在 TCP 上报通道（HTTP 通道不节流），我们挂在
  `/attention/check` 轮询通道（我们的唯一上报源）。
- **共享库 `busy_timeout=5000`** 取自其多核 checkpoint worker 的实测经验值
  （`docs/development/MULTICORE-CPU-OPTIMIZATION-20261002.md`）。
- **「战斗房间去主客化 = 独立专项、排序在存储统一之前」的判断**来自同一路线图的
  「真正多进程迁移顺序」——A2 据此裁剪范围（见下节边界）。

设计哲学上两实现独立收敛：投递都是**读时拉取**（check 时才记账，无写时扇出），
presence 都刻意零持久化，重投递节奏都由房主客户端驱动（客户端事实，非借鉴）。

实质差异（各自取舍，非借鉴）：

| 维度 | 参考服 | 本仓 | 取舍 |
|---|---|---|---|
| 存储 | 纯内存 Map（进程耦合，其路线图列为待迁移项） | SQLite 账本 + `MULTI_SOCIAL_DB_PATH` 共享库 | 本仓目标即共享化，直接落存储 |
| 招募生命周期 | sticky：开启后直到开战/解散 | 45s 有界 + 15s 重发刷新 | 我们 check 无富可用性谓词，有界防死铃铛 |
| 投递资格 | 富谓词：房主 TCP 在线、房间相位、满员、guest 资格缓存 | 仅 open + 未过期 + 未响应 + 非本人 | 参考服耦合房间态；代价是在房成员也收本房铃铛（遗留） |
| attention_key 语义 | 准入门票：无效 key 阻断开战（attention_expired），且须曾被投递 | 尽力而为元数据：fail-open 不阻断开战；不校验投递行 | 不让铃铛故障挡开战；「未校验投递行」是已知放宽 |
| 房主展示字段 | check 时实时投影（收藏队队长头像对齐公共主页、进化段真实值） | share 时快照（进化段恒 0） | 已知遗留，见回归注记 |
| share_type | delta 合并 sticky（后继分享丢 3 不停招） | 请求含 3 才落行 | 客户端 15s 重发恒 [3]，差异被重发掩盖 |
| AI 补位 | 铃铛触发 ai-fill 自动补位 | 无 | 未借鉴（NPC mate 存在但无铃铛触发链） |
| cond92 | 无此概念（is_newbie 仅展示） | 招募行冻结 + quest/start accepted 记账 | 本仓任务计数器需求 |
| 多进程共享 | 无（其迁移未实施） | 共享 SQLite（WAL + BEGIN IMMEDIATE）已落地 | 净新增，超出来源 |

## 回归

- `node tools/social_store_shared.test.cjs`（quick:protocol）：双连接投递/响应/关闭
  可见性、presence 节流/窗口/清扫、env 委托层。
- 既有 `attention_lifecycle` / `attention_routes` / `attention_bell_start` 锁定单进程语义。
